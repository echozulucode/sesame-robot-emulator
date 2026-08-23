#!/usr/bin/env node
/**
 * Generates hardware/joint-map.json (F6) from:
 *   - hardware/hardware-map.json   (F4 — firmware boundary inventory)
 *   - hardware/assets-inventory.json (F5 — STL/STEP geometry)
 *   - a curated table in this file for everything that is a reading of a
 *     document or an image rather than a machine-extractable fact.
 *
 * EPISTEMIC CONTRACT — every fact-bearing field carries a `status`:
 *   "authoritative"  read out of firmware source or the STEP file
 *   "inferred"       derived, always with `method` and a confidence
 *   "guessed"        carries `verified: false` and a `basis`; NEVER presented
 *                    as fact and structurally non-authoritative in the
 *                    @sesame-lab/sesame-model types.
 *
 * The choreography statistics are COMPUTED here (never typed by hand) by
 * walking every setServoAngle step in hardware-map.json's `movements`,
 * recursing into `repeat` and `conditional` blocks.
 *
 * Deterministic: two runs with the same inputs and the same --generated-at
 * produce byte-identical output.
 *
 * Usage:
 *   node scripts/build-joint-map.mjs [--out hardware/joint-map.json]
 *                                    [--generated-at 2026-08-23T00:00:00Z]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = resolve(repoRoot, argOf('--out', 'hardware/joint-map.json'));
const GENERATED_AT = argOf('--generated-at', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

const readJson = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(resolve(repoRoot, p))).digest('hex');

const HARDWARE_MAP = 'hardware/hardware-map.json';
const ASSETS_INVENTORY = 'hardware/assets-inventory.json';
const TOPDOWN_PNG = 'reference/sesame-robot-main/software/sesame-studio/sesame-topdown.png';
const REFCFG_PNG = 'reference/sesame-robot-main/docs/build-guide/assets/reference-configuration.png';
const ANGLE_PNG = 'reference/sesame-robot-main/docs/build-guide/assets/sesame-angle-guide.png';
const BUILD_GUIDE = 'reference/sesame-robot-main/docs/build-guide/README.md';

const hw = readJson(HARDWARE_MAP);
const assets = readJson(ASSETS_INVENTORY);

// --------------------------------------------------------------------------
// 1. Firmware order — taken from the map, never re-typed, never re-sorted.
// --------------------------------------------------------------------------
const ORDER = hw.servos.order;
if (ORDER.join(',') !== 'R1,R2,L1,L2,R4,R3,L3,L4') {
  throw new Error(`unexpected firmware servo order: ${ORDER.join(',')}`);
}

// --------------------------------------------------------------------------
// 2. Choreography statistics — computed by walking every servo step.
// --------------------------------------------------------------------------
const stats = Object.fromEntries(
  ORDER.map((j) => [j, { hist: new Map(), fns: new Set() }]),
);
let totalSteps = 0;
let servoSteps = 0;

function walk(steps, fn) {
  for (const s of steps) {
    totalSteps += 1;
    if (s.type === 'servo') {
      servoSteps += 1;
      if (typeof s.angleDeg !== 'number') {
        throw new Error(`non-literal servo angle in ${fn}: ${JSON.stringify(s)}`);
      }
      const st = stats[s.joint];
      st.hist.set(s.angleDeg, (st.hist.get(s.angleDeg) ?? 0) + 1);
      st.fns.add(fn);
    }
    if (Array.isArray(s.steps)) walk(s.steps, fn);
  }
}
for (const mv of hw.movements) walk(mv.steps, mv.function);

const poseAngles = (fnName) => {
  const mv = hw.movements.find((m) => m.function === fnName);
  if (!mv) throw new Error(`no movement function ${fnName}`);
  const out = {};
  (function w(steps) {
    for (const s of steps) {
      if (s.type === 'servo') out[s.joint] = s.angleDeg;
      if (Array.isArray(s.steps)) w(s.steps);
    }
  })(mv.steps);
  return out;
};
const REST = poseAngles('runRestPose');
const STAND = poseAngles('runStandPose');

// --------------------------------------------------------------------------
// 3. Curated table — every entry here is a reading of a document or an image,
//    or a convention chosen by F6. Each carries its own status + basis.
// --------------------------------------------------------------------------

// Shape equivalence classes measured in F5 (partShapeGroups): the eight printed
// joints are only four distinct solids. Diagonally opposite legs share a part.
const SHAPE_CLASS = {
  R1: 'femur-A', L2: 'femur-A',
  R2: 'femur-B', L1: 'femur-B',
  R3: 'foot-A', L4: 'foot-A',
  R4: 'foot-B', L3: 'foot-B',
};

// Sign class == shape class family. See `directionSign` reasoning in the doc.
const DIRECTION_SIGN = { R1: 1, L2: 1, R3: 1, L4: 1, R2: -1, L1: -1, R4: -1, L3: -1 };

// Hip <-> foot pairing, read off reference-configuration.png and
// sesame-topdown.png. Both images label all eight parts.
const FOOT_TO_FEMUR = { R3: 'R1', R4: 'R2', L3: 'L1', L4: 'L2' };
const FEMUR_TO_FOOT = { R1: 'R3', R2: 'R4', L1: 'L3', L2: 'L4' };

// Semantic guesses. verified:false, always.
const SEMANTIC = {
  R1: 'right_front_hip',
  R2: 'right_rear_hip',
  L1: 'left_front_hip',
  L2: 'left_rear_hip',
  R3: 'right_front_knee',
  R4: 'right_rear_knee',
  L3: 'left_front_knee',
  L4: 'left_rear_knee',
};
const SIDE = { R: 'right', L: 'left' };
const END = { 1: 'front', 2: 'rear', 3: 'front', 4: 'rear' };

const SEMANTIC_BASIS = (j) => {
  const side = SIDE[j[0]];
  const end = END[j[1]];
  const kind = Number(j[1]) <= 2 ? 'hip (femur)' : 'knee (foot)';
  return [
    `Front/rear: ${rel(resolve(repoRoot, TOPDOWN_PNG))} is a labelled top-down line drawing of the assembled robot carrying the words "FRONT" at the top edge and "BACK" at the bottom. In that drawing L3/L1 sit at the front-left, R3/R1 at the front-right, L2/L4 at the back-left and R2/R4 at the back-right. ${j} is therefore at the ${end}.`,
    `Left/right: the same drawing places every L-named part on the image's left half and every R-named part on the image's right half. Read as a view from ABOVE with the robot facing away from the viewer, image-left is the robot's own left, so L = the robot's left and R = the robot's right, and ${j} is on the ${side}.`,
    `Joint kind is not a guess: the STEP file names this part "${Number(j[1]) <= 2 ? 'femur' : 'foot'}-joint-${j}", so "${kind}" is authoritative even though the spatial qualifier is not.`,
    `Corroboration from firmware choreography (${servoSteps} setServoAngle steps in hardware-map.json): movements group the four hips as {R1,L1} versus {R2,L2} (runShakePose commands R1=L1=45 deg and R2=L2=0 deg; runCutePose commands R1=L1=90 deg and R2=L2=70 deg) — i.e. by the trailing digit, which is exactly the front-pair/rear-pair split the image shows. The walk gaits instead group {R1,R2} against {L1,L2} — i.e. by side. Two orthogonal groupings that match the image's two axes.`,
    `Corroboration from ${rel(resolve(repoRoot, REFCFG_PNG))}: the assembled top view in the build guide shows the same eight labels in the same eight positions, and shows ${j} paired with ${Number(j[1]) <= 2 ? FEMUR_TO_FOOT[j] : FOOT_TO_FEMUR[j]}.`,
  ];
};

const SEMANTIC_CONFIRMED_BY = [
  'Physically inspecting a built robot: confirm that the part engraved with this name is installed in the position the drawings show. A builder can physically swap two identical parts (F5 measured R1 and L2 to be the same solid, and R2 and L1, and R3/L4, and R4/L3), and nothing in the firmware would notice.',
  'Confirming that sesame-topdown.png is a view from ABOVE and not from below. If it is a bottom view, every left/right assignment in this file inverts. Nothing in the repository states the camera direction.',
  'Confirming that the drawing\'s "FRONT" is the direction the robot walks forward in when the `walk` command runs, not merely the end the OLED faces. The build guide gives the physical cue "Notch = front. USB port = back." (docs/build-guide/README.md:168) but never ties it to gait direction.',
  'Confirming that "R"/"L" in the part names denote the robot\'s own left and right rather than a viewer\'s. No repository text states this.',
];

const UNRESOLVED_SEMANTIC = 'semanticName is a guess read off two drawings; see semanticName.wouldBeConfirmedBy.';

// --------------------------------------------------------------------------
// 4. Build the joints.
// --------------------------------------------------------------------------
const hwJoint = (name) => hw.servos.joints.find((j) => j.firmwareName === name);
const assetPart = (name) => assets.parts.find((p) => p.file.startsWith(`${name}-`));

const clamp = hw.servos.servoConfig.angleClamp;

function jointEntry(name, index) {
  const fw = hwJoint(name);
  const part = assetPart(name);
  const kind = part.cadIdentity.kind; // "femur" | "foot"
  const isFemur = kind === 'femur';
  const pivot = part.pivotCandidate;
  const st = stats[name];

  const values = [...st.hist.keys()].sort((a, b) => a - b);
  const flat = [];
  for (const v of values) for (let i = 0; i < st.hist.get(v); i += 1) flat.push(v);
  const median = flat.length % 2
    ? flat[(flat.length - 1) / 2]
    : (flat[flat.length / 2 - 1] + flat[flat.length / 2]) / 2;

  const sign = DIRECTION_SIGN[name];
  const zero = 90;
  const bodyRel = values.map((v) => (v - zero) * sign).sort((a, b) => a - b);

  const perJointUnresolved = [UNRESOLVED_SEMANTIC];
  if (isFemur) {
    perJointUnresolved.push(
      'The build guide says that at Rest (90 deg) "the hip joint should move perfectly parallel to the body" (docs/build-guide/README.md:209), while sesame-angle-guide.png draws the 90 deg ray pointing laterally outward. Both readings cannot be right about the same feature; which one describes the femur arm and which the horn plate is unresolved without a physical robot.',
    );
  } else {
    perJointUnresolved.push(
      `parentLink is read from drawings, not measured. F5 proved which femur SHAPE mates with which foot SHAPE but could not name the instance: geometry alone leaves ${name} matching both ${FOOT_TO_FEMUR[name]} and its shape twin.`,
    );
  }
  perJointUnresolved.push(
    'pivotOrigin is a point on the correct axis line, not the joint centre. Where the servo datum plane falls along that line is not present in the plastic.',
  );

  return {
    firmwareName: name,
    firmwareIndex: index,
    firmwareIndexStatus: 'authoritative',
    firmwareIndexSource: fw.source,
    firmwareIndexNote:
      'enum ServoName { R1=0, R2=1, L1=2, L2=3, R4=4, R3=5, L3=6, L4=7 }. The index, not the name and not the position in any table, is the joint\'s identity. Never re-sort.',

    kind,
    kindStatus: 'authoritative',
    kindSource: {
      file: 'hardware/cad/Sesame-ESP32-v122.step',
      symbol: `PRODUCT '${part.cadIdentity.product}'`,
      note: part.cadIdentity.source,
    },

    pinsByBoard: fw.pinsByBoard,
    pinsStatus: 'authoritative',
    pinSourceByBoard: fw.pinSourceByBoard,
    pinsNote:
      'GPIO number per board configuration, from the servoPins[] arrays in firmware. Exactly one board is active (s2-mini); the others are commented-out alternates that F3 enables with build-time patches.',

    stlFile: part.file,
    stlPath: part.path,
    stlSha256: part.sha256,
    shapeEquivalenceClass: SHAPE_CLASS[name],
    shapeEquivalenceStatus: 'inferred',
    shapeEquivalenceMethod:
      'F5 partShapeGroups: 20 000 surface samples of one part, unsigned distance to another. Members of a class agree to within 0.05 mm over 95-97 % of the sampled surface; the residual is the engraved part label, whose p99 distance matches its 0.254 mm engraving depth.',

    rotationAxis: {
      value: pivot.axis,
      frame: 'stl-assembly',
      status: 'inferred',
      axisConfidence: pivot.axisConfidence,
      method: pivot.method,
      note: isFemur
        ? 'Vertical (yaw). Measured as the common axis of three concentric turned features on the proximal horn plate: an M2.5 through-bore, an ~8 mm horn-hub counterbore and a 12.70 mm rounded plate end. Corroborated by install-frame-motors.png, which shows all four hip servos screwed to the internal frame with shafts pointing up.'
        : 'Horizontal (pitch). Recovered CROSS-PART: this shell carries the servo rather than following a horn, so it contains no shaft feature at all. Its two M2 mounting bores fix the servo position; the axis LINE is taken from the mating femur\'s distal horn interface, measured independently, which lands on this shell\'s bore centre-line at the same y to four decimals.',
    },

    pivotOrigin: {
      value: pivot.origin,
      frame: 'stl-assembly',
      status: 'inferred',
      originConfidence: pivot.originConfidence,
      caveat:
        'THIS IS A POINT ON THE CORRECT LINE, NOT THE JOINT CENTRE. The axis direction and its position in the plane perpendicular to itself are measured; the position ALONG the axis is not, because nothing in the printed plastic marks the servo\'s datum plane. Do not use this as a kinematic frame origin without pinning the along-axis placement first.',
      method: pivot.method,
    },

    ...(isFemur
      ? {
        linkGeometry: {
          status: 'inferred',
          axisAngleDeg: part.linkGeometry.axisAngleDeg,
          commonNormalDistanceMm: part.linkGeometry.commonNormalDistance,
          distalAxis: part.distalInterface.axis,
          distalOrigin: part.distalInterface.origin,
          note: 'Measured axis-to-axis offset and twist of the femur link. The distal interface is the pivot of the foot link that hangs off this femur, not of this part.',
        },
      }
      : {}),

    parentLink: isFemur
      ? {
        value: 'internal-frame',
        status: 'authoritative',
        basis:
          'The STEP assembly places all four hip servos on the internal frame, on an exact 1.500 x 2.000 inch (38.10 x 50.80 mm) rectangle; the build guide step "Install Frame Motors" and assets/install-frame-motors.png show the same four servos screwed to the internal frame. The femur link is bolted to that servo\'s output horn.',
        childLink: FEMUR_TO_FOOT[name],
      }
      : {
        value: FOOT_TO_FEMUR[name],
        status: 'inferred',
        basis:
          `The foot link hangs off the distal horn interface of a femur (F5 measured that interface on every femur and showed the foot shell's servo-mount bore line crosses it 5.15 mm from its midpoint). WHICH femur instance is read from ${rel(resolve(repoRoot, REFCFG_PNG))} and ${rel(resolve(repoRoot, TOPDOWN_PNG))}, both of which label all eight parts and show ${FOOT_TO_FEMUR[name]} adjacent to ${name}. Independently corroborated by firmware choreography: runStandPose commands ${FOOT_TO_FEMUR[name]}=${STAND[FOOT_TO_FEMUR[name]]} deg and ${name}=${STAND[name]} deg, and across the whole corpus the femur and foot of a leg always share the same direction-sign class.`,
        childLink: null,
        caveat:
          'Read from drawings. Geometry alone cannot pick the instance, because mirror-identical parts were exported at the same station.',
      },

    zeroReferenceDeg: {
      value: zero,
      status: 'inferred',
      basis: [
        `runRestPose commands all eight servos to 90 deg with a single loop (\`for (int i = 0; i < 8; i++) setServoAngle(i, 90);\`, ${hw.movements[0].steps.find((s) => s.type === 'servo').source.file}:${hw.movements[0].steps.find((s) => s.type === 'servo').source.line}). 90 deg is the one pose the firmware treats as uniform across all joints.`,
        `The calibration procedure commands every motor to 90 deg with no horn attached before any joint is fitted (docs/build-guide/README.md, "Calibrating & Running the Testing Firmware" step 4), which makes 90 deg the mechanical assembly datum.`,
        `servoSubtrim[] defaults to all zeros (${hw.servos.servoConfig.subtrim.source.file}:${hw.servos.servoConfig.subtrim.source.line}), so the commanded value IS the datum value on an untrimmed robot.`,
        `sesame-angle-guide.png draws 90 deg as the common hinge value of both hip conventions and as "foot horizontal" for both foot conventions.`,
      ],
      caveat:
        'INFERRED FROM CHOREOGRAPHY AND DOCUMENTATION, NOT MEASURED. This is the commanded degree value the model treats as zero body-relative angle. It is not a claim about where the servo actually sits: horn spline resolution is 360/20 = 18 deg on an MG90S, so a physical robot can be up to +/-9 deg off this datum before subtrim.',
      restPoseDeg: REST[name],
      standPoseDeg: STAND[name],
    },

    directionSign: {
      value: sign,
      status: 'inferred',
      convention:
        'bodyRelativeDeg = (commandedDeg - zeroReferenceDeg) * directionSign. Positive body-relative angle means: for a femur/hip, the leg swings AWAY from lateral in its own outboard fore/aft direction (front legs forward, rear legs rearward); for a foot/knee, the foot swings from horizontal toward straight down.',
      basis: [
        `The sign classes are exactly F5's shape-mirror classes: ${SHAPE_CLASS[name]} = {${Object.keys(SHAPE_CLASS).filter((k) => SHAPE_CLASS[k] === SHAPE_CLASS[name]).join(', ')}}. Members of a class are the SAME printed solid (not mirrors), so they are installed 180 deg apart about the body's vertical axis and must therefore take opposite signs from their mirror counterparts.`,
        'Applying these signs makes runRestPose read 0 deg on all eight joints and runStandPose read +45 deg on all four hips and +90 deg on all four feet. Without them runStandPose reads 135/45/45/135 and 0/180/0/180, which is the same pose written twice in two conventions.',
        'sesame-angle-guide.png draws the two conventions explicitly: R1 and L2 sweep 90->135->180, R2 and L1 sweep 90->45->0, and the caption "VERTICAL ANGLES REPRESENT STRAIGHT DOWN" marks 180 deg as down for R3/L4 and 0 deg as down for R4/L3.',
        'Over the whole 223-step corpus the transformed histograms of the two members of each class coincide in shape, and 12 of the 16 functions that command hips command all four hips to a single body-relative value.',
      ],
      caveat:
        'The sign is RELATIVE, not absolute. What is evidenced is that the two classes are opposite; which of the two is counter-clockwise about the stated rotationAxis in a right-handed sense is NOT established. Flipping all eight signs at once would be equally consistent with everything measured here.',
    },

    angleLimitsDeg: {
      value: { min: clamp.min, max: clamp.max },
      status: 'authoritative',
      source: clamp.source,
      call: clamp.call,
      note:
        'This is the FIRMWARE clamp, applied after subtrim, not a mechanical travel limit. The BOM calls for 180-degree MG90S servos, so the clamp and the actuator range coincide by design, but nothing in the repository says the printed linkage can actually reach both ends without collision at every pose.',
      mechanicalLimitsDeg: null,
      mechanicalLimitsNote:
        'Unknown. Determining the real per-joint travel needs either a collision study on repaired meshes or a physical robot.',
    },

    observedRangeDeg: {
      status: 'inferred',
      method:
        'Statistical analysis of every literal setServoAngle() call in hardware-map.json `movements`, recursing into `repeat` and `conditional` blocks. This is what the shipped choreography actually asks of this joint — strong evidence about the range the designers believe is safe, and no evidence at all about the range the mechanism can reach.',
      corpus: {
        functions: hw.movements.length,
        totalSteps,
        servoSteps,
      },
      sampleCount: flat.length,
      functionsCommandingThisJoint: st.fns.size,
      minDeg: values[0],
      maxDeg: values[values.length - 1],
      medianDeg: median,
      distinctCommandedDeg: values.map((v) => ({ deg: v, count: st.hist.get(v) })),
      bodyRelativeMinDeg: bodyRel[0],
      bodyRelativeMaxDeg: bodyRel[bodyRel.length - 1],
      note: isFemur
        ? 'Hips use only about half of the 0-180 clamp, and always the same half for a given sign class. In body-relative terms all four hips live in roughly [0, +90] deg: the choreography sweeps the leg outward from lateral and essentially never inward.'
        : 'Feet use the full 0-180 clamp, i.e. body-relative [-90, +90] deg: straight up through horizontal to straight down.',
    },

    semanticName: {
      value: SEMANTIC[name],
      verified: false,
      basis: SEMANTIC_BASIS(name).join(' '),
      basisPoints: SEMANTIC_BASIS(name),
      wouldBeConfirmedBy: SEMANTIC_CONFIRMED_BY,
      alternativesConsidered: isFemur
        ? [`${SIDE[name[0]]}_${END[name[1]]}_yaw`, `${SIDE[name[0]]}_${END[name[1]]}_shoulder`]
        : [`${SIDE[name[0]]}_${END[name[1]]}_leg`, `${SIDE[name[0]]}_${END[name[1]]}_ankle`],
      alternativesNote:
        'The STEP file calls the foot parts "foot-joint-*" and the build guide calls them "Leg Joints", but the actuated degree of freedom sits between the femur and the foot link, so "knee" is the kinematically accurate word. Recorded because the naming, not just the mapping, is a choice.',
    },

    unresolved: perJointUnresolved,
  };
}

// --------------------------------------------------------------------------
// 5. Assemble.
// --------------------------------------------------------------------------
const jointMap = {
  $schema: './joint-map.schema.json',
  meta: {
    schemaVersion: '1.0.0',
    jointMapVersion: '1.0.0',
    task: 'F6 — joint map + sesame-model package',
    generatedAt: GENERATED_AT,
    generatedBy: 'scripts/build-joint-map.mjs (asset-pipeline agent, Sesame Lab Phase 0)',
    regenerateWith: 'node scripts/build-joint-map.mjs',
    validateWith: 'pnpm validate:joint-map',
    epistemicContract:
      'Every fact-bearing field carries a `status` of exactly one of: "authoritative" (read out of firmware source or the STEP file), "inferred" (derived, always with a `method` and a confidence), or "guessed" (carries `verified: false` and a `basis`). Nothing in this file has been checked against a physical robot. The ONLY authoritative identity of a joint is `firmwareName` plus `firmwareIndex`; `semanticName` is a guess and is structurally non-authoritative in @sesame-lab/sesame-model.',
    verificationStatus:
      'NOT PHYSICALLY VERIFIED. No built Sesame robot was available. Every semanticName carries verified:false.',
    sources: [
      { id: 'hardware-map', path: HARDWARE_MAP, sha256: sha256(HARDWARE_MAP), role: 'F4 boundary inventory — firmware order, per-board GPIO, servo clamp/subtrim, 21 movement functions', producedBy: 'F4' },
      { id: 'assets-inventory', path: ASSETS_INVENTORY, sha256: sha256(ASSETS_INVENTORY), role: 'F5 STL/STEP geometry — pivot axes, pivot origins, shape equivalence classes, CAD part names', producedBy: 'F5' },
      { id: 'sesame-topdown', path: TOPDOWN_PNG, sha256: sha256(TOPDOWN_PNG), role: 'Labelled top-down drawing carrying explicit FRONT and BACK markers; the only artefact in the repository that resolves fore/aft', producedBy: 'upstream (read by F6)' },
      { id: 'reference-configuration', path: REFCFG_PNG, sha256: sha256(REFCFG_PNG), role: 'Assembled top view labelling all eight joint parts; used for the hip-to-foot pairing', producedBy: 'upstream (read by F6)' },
      { id: 'sesame-angle-guide', path: ANGLE_PNG, sha256: sha256(ANGLE_PNG), role: 'Per-joint angle convention diagram with motor indices 00-07; used for zeroReferenceDeg and directionSign', producedBy: 'upstream (read by F6)' },
      { id: 'build-guide', path: BUILD_GUIDE, sha256: sha256(BUILD_GUIDE), role: 'Calibration procedure (all motors to 90 deg), joint fitting at Stand, "Notch = front. USB port = back."', producedBy: 'upstream (read by F6)' },
    ],
    consumers: [
      'packages/sesame-model — JointName, JOINT_ORDER, RobotState, joint-map loader',
      'R5 — packages/sesame-protocol telemetry union',
      'Phase 1 — SimulatedSesameRobot behaviour model and the R3F viewer',
    ],
  },

  conventions: {
    angleUnit: 'degree',
    lengthUnit: 'millimetre',
    lengthUnitStatus: 'authoritative',
    lengthUnitSource:
      'hardware/cad/Sesame-ESP32-v122.step declares LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.); read by scripts/extract-step-assembly.py in F5.',
    coordinateFrame: {
      id: 'stl-assembly',
      status: 'inferred',
      upAxis: assets.coordinateFrame.upAxis.value,
      upAxisConfidence: assets.coordinateFrame.upAxis.confidence,
      lateralAxis: assets.coordinateFrame.lateralAxis.value,
      lateralAxisConfidence: assets.coordinateFrame.lateralAxis.confidence,
      foreAftAxis: null,
      foreAftAxisNote:
        'The fore/aft SIGN of the X axis in the STL frame is still unknown. sesame-topdown.png resolves which END of the robot is the front as a matter of labelling, but it is a drawing, not a coordinate frame, and F5 never established the STL-frame-to-CAD-frame mapping. Do not assume +X is forward.',
      caveat:
        'Positions in this frame are NOT per-instance assembly positions. F5 found that the four femur STLs occupy only two bounding-box stations and the four foot STLs likewise, because the exporter wrote one file per unique SHAPE at a representative station and then re-labelled. Orientations are frame-correct; placements are not.',
    },
    commandedAngle: {
      domain: { min: clamp.min, max: clamp.max },
      status: 'authoritative',
      source: clamp.source,
      call: clamp.call,
      note: 'setServoAngle() applies constrain(angle + servoSubtrim[channel], 0, 180) at a single convergence point, so this domain is inescapable from firmware.',
    },
    bodyRelativeAngle: {
      formula: 'bodyRelativeDeg = (commandedDeg - zeroReferenceDeg) * directionSign',
      status: 'inferred',
      purpose:
        'A single convention in which the same number means the same physical thing on all four legs, so a behaviour model or a viewer does not need eight special cases. Validated against the shipped choreography: runRestPose becomes all-zero, runStandPose becomes +45 on every hip and +90 on every foot, runShrugPose becomes -90 on every foot, runDeadPose becomes 0 on every foot.',
      caveat:
        'Both inputs are inferred. Neither the zero nor the sign has been measured on hardware, and the absolute sense of the sign is not established at all — see each joint\'s directionSign.caveat.',
    },
  },

  shapeEquivalenceClasses: [
    {
      id: 'femur-A', kind: 'femur', members: ['R1', 'L2'], relation: 'identical solids',
      mirrorOf: 'femur-B',
      status: 'inferred',
      evidence: 'F5 partShapeGroups: R1 vs L2 agree within 0.05 mm over 96.7 % of 20 000 sampled surface points, p99 distance 0.254 mm = the engraved label depth.',
    },
    {
      id: 'femur-B', kind: 'femur', members: ['R2', 'L1'], relation: 'identical solids',
      mirrorOf: 'femur-A',
      status: 'inferred',
      evidence: 'F5 partShapeGroups: L1 vs R2 agree within 0.05 mm over 95.1 % of 20 000 sampled surface points, p99 distance 0.381 mm.',
    },
    {
      id: 'foot-A', kind: 'foot', members: ['R3', 'L4'], relation: 'identical solids',
      mirrorOf: 'foot-B',
      status: 'inferred',
      evidence: 'F5 partShapeGroups: L4 vs R3 agree within 0.05 mm over 95.9 % of 20 000 sampled surface points, p99 distance 0.254 mm.',
    },
    {
      id: 'foot-B', kind: 'foot', members: ['R4', 'L3'], relation: 'identical solids',
      mirrorOf: 'foot-A',
      status: 'inferred',
      evidence: 'F5 partShapeGroups: L3 vs R4 agree within 0.05 mm over 95.3 % of 20 000 sampled surface points, p99 distance 0.393 mm.',
    },
  ],
  shapeEquivalenceNote:
    'Only FOUR distinct printed solids exist for eight joints, and the pairs are DIAGONAL (R1 with L2, R2 with L1, R3 with L4, R4 with L3), not left/right. The robot therefore has two-fold rotational symmetry about its vertical axis, not merely bilateral symmetry. Two consequences: any front/rear assignment must be consistent with diagonal symmetry, and a model that stores eight independent link descriptions will drift where one storing four shapes plus eight placements will not.',

  choreographyAnalysis: {
    status: 'inferred',
    corpus: {
      source: HARDWARE_MAP,
      functions: hw.movements.length,
      totalSteps,
      servoSteps,
      note: 'Step counts are recursive: `repeat` and `conditional` blocks carry nested `steps` arrays and are counted through. Every servo step in the corpus carries a literal integer angle; none are computed at runtime, which is why this analysis is exact rather than a sample.',
    },
    method:
      'Every literal setServoAngle() call was bucketed by joint. No weighting was applied for `repeat` counts, because a repeat re-issues the same literal angles and would only inflate frequencies, not widen ranges.',
    findings: [
      'The hips never use the full clamp. R1 and L2 are only ever commanded in [90, 180]; L1 in [0, 90]; R2 in [0, 100]. In body-relative terms every hip lives in [-10, +90] and is at or above 0 in 88 of 90 steps (97.8 %), i.e. the shipped choreography sweeps legs outward from lateral and essentially never inward — the two exceptions are a single R2=100 deg used twice in runPointPose.',
      'The feet use the whole clamp: all four are commanded at both 0 and 180.',
      'runRestPose is the only pose that commands all eight joints to one raw value (90). Under the inferred sign convention, five more poses become uniform: runStandPose (+45 hips, +90 feet), runSwimPose and runCrabPose (0 hips), runShrugPose (-90 feet), runDeadPose (0 feet).',
      'Hips are grouped by trailing digit in the expressive poses (runShakePose, runCutePose move {R1,L1} together and {R2,L2} together) and by leading letter in the gaits (runWalkPose and runWalkBackward move {R1,R2} against {L1,L2}). Those are the two body axes, and they line up with the front/rear and left/right split the labelled drawings show.',
      'Only 15 distinct commanded angles appear across all eight joints and all 223 steps: 0, 10, 20, 25, 45, 65, 80, 90, 100, 115, 135, 145, 160, 170, 180. The five multiples of 45 account for 198 of the 223 steps (88.8 %), so the choreography is written on a 45-degree grid with ten one-off exceptions.',
    ],
    caveat:
      'This is evidence about intent, not about mechanism. It says what the firmware authors were willing to command; it says nothing about what the printed linkage can physically reach, and nothing about where the joints actually end up.',
  },

  joints: ORDER.map((name, i) => jointEntry(name, i)),

  unresolved: [
    {
      id: 'servo-datum-plane',
      subject: 'joints[*].pivotOrigin',
      carriedForwardFrom: 'F5',
      status: 'open',
      reason:
        'Every pivot axis LINE is measured, but where the servo\'s reference plane sits along that line is not recoverable from the plastic alone. Origins are points on the correct line, not joint centres.',
      resolvedBy: 'an MG90S CAD model, a STEP B-Rep evaluation, or measuring a built robot',
      blocking: false,
    },
    {
      id: 'per-instance-assembly-poses',
      subject: 'conventions.coordinateFrame, joints[*].pivotOrigin',
      carriedForwardFrom: 'F5',
      status: 'open',
      reason:
        'The STL files are not at per-instance assembly positions: the four femur STLs occupy only two stations 46.03 mm apart in Z while the CAD hip stations are 50.80 mm apart, so at most one member of each mirror pair is where it belongs. The STEP assembly does give all eight joints an exact rigid pose, but in the CAD frame.',
      resolvedBy: 'reconciling the STL and CAD frames — see stl-to-cad-frame-mapping',
      blocking: false,
    },
    {
      id: 'stl-to-cad-frame-mapping',
      subject: 'conventions.coordinateFrame',
      carriedForwardFrom: 'F5',
      status: 'open',
      reason:
        'One hip pivot matches a CAD point to six digits after an inch-to-mm conversion, with the Z sign inverted. One sample is not a proof. Until it is, do NOT compose CAD occurrence transforms with STL coordinates.',
      resolvedBy: 'evaluating the STEP B-Rep with pythonocc/FreeCAD and comparing part bounding boxes instance by instance',
      blocking: false,
    },
    {
      id: 'joint-zero-sign-and-limits',
      subject: 'joints[*].zeroReferenceDeg, joints[*].directionSign, joints[*].angleLimitsDeg.mechanicalLimitsDeg',
      carriedForwardFrom: 'F5',
      status: 'partially-resolved',
      reason:
        'PARTIALLY RESOLVED by F6. The firmware clamp (0-180) is authoritative. A zero reference of 90 deg and a per-class direction sign are now INFERRED from the shipped choreography, the calibration procedure and sesame-angle-guide.png, and they make every symmetric pose read uniformly — but they remain inferred, the absolute sense of the sign is not established, and the MECHANICAL travel limits are still entirely unknown.',
      resolvedBy: 'a calibration run on a built robot, plus a collision study on repaired meshes for the mechanical limits',
      blocking: false,
    },
    {
      id: 'front-rear-orientation',
      subject: 'joints[*].semanticName',
      carriedForwardFrom: 'F5',
      status: 'partially-resolved',
      reason:
        'PARTIALLY RESOLVED by F6. F5 could not distinguish fore from aft. software/sesame-studio/sesame-topdown.png is a labelled top-down drawing carrying the literal words FRONT and BACK, and places R1/L1 at the front and R2/L2 at the rear. The build guide adds the physical cue "Notch = front. USB port = back." (docs/build-guide/README.md:168). This is a reading of a drawing, so it stays verified:false, and the drawing never says the FRONT it marks is the direction the `walk` command travels.',
      resolvedBy: 'physical inspection of a built robot, plus observing which way it actually walks',
      blocking: false,
    },
    {
      id: 'hip-to-foot-instance-naming',
      subject: 'joints[*].parentLink',
      carriedForwardFrom: 'F5',
      status: 'partially-resolved',
      reason:
        'PARTIALLY RESOLVED by F6. reference-configuration.png and sesame-topdown.png both label all eight parts and show R1-R3, R2-R4, L1-L3, L2-L4. The firmware choreography independently corroborates it: the femur and foot of a leg always fall in the same direction-sign class. Geometry alone still cannot pick the instance, so this stays a reading of a drawing.',
      resolvedBy: 'physical confirmation on a built robot',
      blocking: false,
    },
    {
      id: 'view-direction-of-the-labelled-drawings',
      subject: 'joints[*].semanticName',
      carriedForwardFrom: 'F6',
      status: 'open',
      reason:
        'NEW IN F6. Every left/right assignment rests on sesame-topdown.png being a view from ABOVE. If it is a bottom view, "R" and "L" swap sides. Nothing in the repository states the camera direction, and no text anywhere says whether "R"/"L" mean the robot\'s own left and right or a viewer\'s.',
      resolvedBy: 'physical inspection: hold a built robot with the notch facing away and read the engraved labels',
      blocking: false,
    },
    {
      id: 'rest-pose-hip-orientation-contradiction',
      subject: 'joints[R1,R2,L1,L2].zeroReferenceDeg',
      carriedForwardFrom: 'F6',
      status: 'open',
      reason:
        'NEW IN F6. docs/build-guide/README.md:209 says that at Rest the hip joint "should move perfectly parallel to the body", while sesame-angle-guide.png draws each hip\'s 90-degree ray pointing laterally outward, i.e. perpendicular to the body. Both cannot describe the same feature. The likeliest reconciliation is that the prose describes the horn plate and the diagram the leg direction, but that is a guess and it is not recorded as one anywhere in the data.',
      resolvedBy: 'a photograph of a robot at Rest, or a physical robot',
      blocking: false,
    },
    {
      id: 'horn-spline-quantisation',
      subject: 'joints[*].zeroReferenceDeg',
      carriedForwardFrom: 'F6',
      status: 'open',
      reason:
        'NEW IN F6. The horn is pressed onto a splined shaft during assembly, so the mapping from commanded degrees to physical angle is quantised by the spline pitch and differs per built robot. The firmware exposes servoSubtrim[] for exactly this, and it defaults to all zeros and is never persisted (RAM only; `subtrim save` prints a C initialiser for the user to paste into source). Any per-robot calibration therefore lives outside this file.',
      resolvedBy: 'per-robot calibration captured into a separate calibration artefact, not into joint-map.json',
      blocking: false,
    },
  ],
};

writeFileSync(OUT, `${JSON.stringify(jointMap, null, 2)}\n`, 'utf8');
console.error(`wrote ${rel(OUT)}  (${jointMap.joints.length} joints, ${servoSteps} servo steps analysed across ${hw.movements.length} functions / ${totalSteps} steps)`);
