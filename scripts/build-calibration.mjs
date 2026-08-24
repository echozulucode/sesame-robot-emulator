#!/usr/bin/env node
/**
 * Generates hardware/calibration.json — the V6 calibration layer.
 *
 * The document layers OVER hardware/joint-map.json; it does not fork it. Every
 * carried-forward value is *derived here from the joint map* rather than typed
 * in, and `scripts/validate-calibration.mjs` re-derives the same values and
 * fails on any drift. That is the mechanism that makes it impossible to change
 * a hardware-gated number without also claiming, in the data, that somebody
 * measured it on a named robot.
 *
 * Deterministic: two runs with the same --generated-at produce byte-identical
 * output.
 *
 * Usage:
 *   node scripts/build-calibration.mjs [--generated-at ISO] [--out path]
 *   node scripts/build-calibration.mjs --check     (regenerate and diff, exit 1 on drift)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const check = argv.includes('--check');

const JOINT_MAP_PATH = resolve(repoRoot, 'hardware/joint-map.json');
const OUT_PATH = resolve(repoRoot, flag('out', 'hardware/calibration.json'));

const jointMapRaw = readFileSync(JOINT_MAP_PATH);
const jointMap = JSON.parse(jointMapRaw.toString('utf8'));
const jointMapSha = createHash('sha256').update(jointMapRaw).digest('hex');

const generatedAt = flag(
  'generated-at',
  check ? JSON.parse(readFileSync(OUT_PATH, 'utf8')).meta.generatedAt : new Date().toISOString(),
);

const SCHEMA_VERSION = '1.0.0';
const CALIBRATION_VERSION = '1.0.0';
const CHECKLIST = 'docs/findings/V6-hardware-verification-checklist.md';

const ISSUE_JOINT_MAP = 'ISSUE-20260823-007';
const ISSUE_SILICON = 'ISSUE-20260823-008';

/** A value nobody has measured. Shape must match `CarriedForwardValue<T>`. */
const carried = (value, { source, method, wouldBeConfirmedBy, checklistStep, closesIssues, note }) => {
  const out = {
    value,
    measured: false,
    source,
    method,
    wouldBeConfirmedBy,
    checklistStep,
    closesIssues,
  };
  if (note !== undefined) out.note = note;
  return out;
};

// ---------------------------------------------------------------------------
// Per-joint fields, derived from the joint map
// ---------------------------------------------------------------------------

const HORN_TEETH = 20;
const HORN_QUANTUM_DEG = 360 / HORN_TEETH;

const joints = jointMap.joints.map((j, index) => {
  const name = j.firmwareName;
  const rule = j.directionSign.absoluteSense?.rule ?? '';
  const senseMatch = /=\s*([+-]?1)\s*\*/.exec(rule);
  if (senseMatch === null) {
    throw new Error(`${name}: cannot read the absolute rotation sense out of joint-map.json`);
  }
  const rotationSense = Number(senseMatch[1]);

  return {
    firmwareName: name,
    firmwareIndex: index,

    directionSign: carried(j.directionSign.value, {
      source: `hardware/joint-map.json joints[${name}].directionSign.value`,
      method:
        'Inferred by F6 from the 223-step choreography corpus: applying these signs collapses runRestPose to 0 on all eight and runStandPose to +45 hips / +90 feet. A bookkeeping convention for the body-relative formula, not a physical direction.',
      wouldBeConfirmedBy: [
        'Commanding one joint of each shape class from 90 deg to 135 deg on a built robot and confirming the two classes move in opposite body-relative directions (checklist V6-18).',
      ],
      checklistStep: 'V6-18',
      closesIssues: [ISSUE_JOINT_MAP],
    }),

    rotationSenseSign: carried(rotationSense, {
      source: `hardware/joint-map.json joints[${name}].directionSign.absoluteSense.rule`,
      method:
        'Fitted exactly by V0 over the CAD servo-horn occurrences: alpha = slope * (commandedDeg - 90) + offset solves uniquely with offset 0 and zero residual. A statement about the DESIGN, resting on two stated assumptions - that the CAD is drawn in runStandPose, and that the servo turns one shaft degree per commanded degree.',
      wouldBeConfirmedBy: [
        'Commanding this joint from 90 deg to 135 deg on an elevated built robot and watching which way the child link swings (checklist V6-18).',
      ],
      checklistStep: 'V6-18',
      closesIssues: [ISSUE_JOINT_MAP],
      note: 'This is the sign baked into assets/sesame.glb as extras.signPerCommandedDeg. Overriding it here does NOT rewrite the GLB - see docs/findings/V6-calibration-and-hardware-checklist.md section 5.',
    }),

    zeroReferenceDeg: carried(j.zeroReferenceDeg.value, {
      source: `hardware/joint-map.json joints[${name}].zeroReferenceDeg.value`,
      method:
        'Inferred by F6 from four independent places: runRestPose commands all eight to 90 in one loop; the build guide calibrates every motor to 90 with no horn fitted; servoSubtrim[] defaults to zeros; sesame-angle-guide.png draws 90 as the shared hinge. NOT MEASURED on any robot.',
      wouldBeConfirmedBy: [
        'Commanding 90 deg on a built robot with the leg fitted and reading the actual link angle against the body with a protractor; the difference is this joint\'s horn-spline offset (checklist V6-19, V6-20).',
      ],
      checklistStep: 'V6-20',
      closesIssues: [ISSUE_JOINT_MAP],
    }),

    servoSubtrimDeg: carried(0, {
      source: 'firmware/sesame-firmware-main.ino:113 — int8_t servoSubtrim[8] = {0,0,0,0,0,0,0,0}',
      method:
        'The firmware default. Subtrim is per-build by construction and the stock firmware never persists it: `subtrim save` prints a C initialiser for a human to paste back into source.',
      wouldBeConfirmedBy: [
        'A calibration run on a specific robot: command the rest pose, trim each channel until the link matches the reference geometry, then read the values back with the serial `subtrim` command (checklist V6-20).',
      ],
      checklistStep: 'V6-20',
      closesIssues: [ISSUE_JOINT_MAP, 'unresolved:horn-spline-quantisation'],
      note: 'Applied BEFORE the firmware clamp: constrain(angle + servoSubtrim[channel], 0, 180). A trimmed channel therefore saturates on a request that is legal untrimmed.',
    }),

    hornSplineOffsetDeg: carried(0, {
      source: 'assumed zero; nothing in the repository establishes it',
      method:
        `The horn is pressed onto a splined output shaft at assembly, so the commanded-to-physical mapping is quantised at 360/${HORN_TEETH} = ${HORN_QUANTUM_DEG} deg and each build lands up to +/-${HORN_QUANTUM_DEG / 2} deg away from the datum. Unreachable from CAD by construction. Zero is the no-information default, not a finding.`,
      wouldBeConfirmedBy: [
        'Measuring the physical link angle at commanded 90 deg on a specific robot BEFORE any subtrim is applied (checklist V6-20). The residual is this number.',
      ],
      checklistStep: 'V6-20',
      closesIssues: ['unresolved:horn-spline-quantisation'],
    }),

    mechanicalLimitsDeg: carried(j.angleLimitsDeg.mechanicalLimitsDeg, {
      source: `hardware/joint-map.json joints[${name}].angleLimitsDeg.mechanicalLimitsDeg (null)`,
      method:
        'Genuinely unknown. The firmware clamp is 0..180 and is authoritative, but nothing says the printed linkage can reach both ends without collision. V0 reconstructed one pose; it swept nothing.',
      wouldBeConfirmedBy: [
        'A slow single-joint sweep on an elevated robot with the supply current watched for stall (checklist V6-22), or a collision study on repaired meshes.',
      ],
      checklistStep: 'V6-22',
      closesIssues: [ISSUE_JOINT_MAP, 'unresolved:joint-zero-sign-and-limits'],
    }),

    safeTravelDeg: carried(null, {
      source: 'not established',
      method:
        'A conservative sub-range that is safe to command with the robot elevated and unloaded. Deliberately null: inventing one would give a false sense of safety, and the shipped choreography is the only range anyone has evidence for.',
      wouldBeConfirmedBy: [
        'Deriving it from the measured mechanical limits with a margin, once V6-22 has run (checklist V6-23).',
      ],
      checklistStep: 'V6-23',
      closesIssues: [ISSUE_JOINT_MAP],
      note: 'Until this is filled in, the shipped 395-step choreography is the only commanded range with any evidence behind it - and that is evidence of the firmware authors\' intent, not of the mechanism.',
    }),

    powerOnCommandedDeg: carried(null, {
      source: 'firmware/sesame-firmware-main.ino:746 — setup() attaches the servos and deliberately does not command them',
      method:
        'Genuinely undetermined, and not a gap in any extractor. Where a horn sits when the servo is attached but never written depends on the servo\'s own power-on behaviour and on where the builder left it. Null means "unknown for this joint"; the whole-robot fallback of 90 is what the simulator uses because RobotState.commandedDeg is a required number.',
      wouldBeConfirmedBy: [
        'Powering a built robot with no command and reading each link angle with a protractor. V1 costed this at about ten seconds per joint (checklist V6-13).',
      ],
      checklistStep: 'V6-13',
      closesIssues: [ISSUE_JOINT_MAP],
    }),

    partIdentity: carried(null, {
      source: `hardware/joint-map.json joints[${name}].semanticName — verified:false`,
      method:
        'V0 established from the CAD where the body NAMED this joint belongs. It cannot establish that the servo on this firmware channel drives the printed part ENGRAVED with this name on a particular build: F5 measured R1 = L2, R2 = L1, R3 = L4 and R4 = L3 as identical solids, so two parts can be swapped at assembly and neither the firmware nor the CAD would notice.',
      wouldBeConfirmedBy: [
        'Reading the engraving on the part actually installed on this servo channel, on a built robot (checklist V6-02). This is the ONLY remaining gap in the spatial name.',
      ],
      checklistStep: 'V6-02',
      closesIssues: [ISSUE_JOINT_MAP, 'unresolved:parts-installed-where-drawn'],
      note: 'A measured value here is the only thing that can promote the joint map\'s semanticName from a guess. It does so through CalibrationView.semanticNameFor(), never by editing joint-map.json.',
    }),
  };
});

// ---------------------------------------------------------------------------
// Whole-robot fields
// ---------------------------------------------------------------------------

const robot = {
  servoModel: carried('unknown', {
    source: 'hardware/bom/README.md (MG90S) vs firmware/upstream/hardware/cad/Sesame-ESP32-v122.step (SG90)',
    method:
      'Contested, so recorded as unknown rather than picked. The BOM calls for MG90S; the CAD models a Tower Pro SG90. Same 32.2 x 12 x 30 mm footprint and same 27.8 mm ear pitch, so the printed parts fit either - but the servo-shaft datum V0 recorded is the SG90\'s, and torque, slew and spline are not the same part.',
    wouldBeConfirmedBy: [
      'Reading the label on a servo removed from a built robot, or on a spare from the same order (checklist V6-04). A loose servo is enough - no assembled robot required.',
    ],
    checklistStep: 'V6-04',
    closesIssues: ['unresolved:servo-model-is-sg90-not-mg90s'],
  }),

  hornSplineTeeth: carried(HORN_TEETH, {
    source: 'MG90S output-spline specification',
    method:
      `A specification, not a count. Sets the horn quantum at 360/${HORN_TEETH} = ${HORN_QUANTUM_DEG} deg and therefore the +/-${HORN_QUANTUM_DEG / 2} deg worst case quoted throughout F6 and V0. If the fitted servo is an SG90 the count may differ.`,
    wouldBeConfirmedBy: [
      'Counting the teeth on a servo output shaft under magnification (checklist V6-16). One loose servo, five minutes.',
    ],
    checklistStep: 'V6-16',
    closesIssues: ['unresolved:horn-spline-quantisation'],
  }),

  angleGainDegPerCommandedDeg: carried(1, {
    source: 'firmware/sesame-firmware-main.ino:742 — servos[i].attach(servoPins[i], 732, 2929)',
    method:
      'Assumed exactly 1.0. The firmware maps 0..180 commanded degrees onto 732..2929 us of pulse width; whether a real servo sweeps exactly 180 mechanical degrees over that window is a property of the servo, not of the firmware. V0\'s absolute-sense fit states this assumption explicitly rather than hiding it.',
    wouldBeConfirmedBy: [
      'Commanding 0 and 180 on a bench servo with a horn and a protractor and measuring the swept angle (checklist V6-14). One loose servo; no robot.',
    ],
    checklistStep: 'V6-14',
    closesIssues: [ISSUE_JOINT_MAP],
    note: '732..2929 us is an unusual window - the common default is 500..2500 - so the assumption is worth checking rather than assuming it is the library default.',
  }),

  slewDegPerSec: carried(600, {
    source: '@sesame-lab/sesame-sim DEFAULT_SLEW_DEG_PER_SEC',
    method:
      'The MG90S DATASHEET figure, 0.1 s per 60 deg at 4.8 V, with no load, no gear backlash and no supply sag. Nobody has timed this robot\'s servos. It drives simulatedDeg only; measuredDeg stays null because the stock robot has no position feedback at all.',
    wouldBeConfirmedBy: [
      'Timing a 60 deg step on a bench servo, unloaded (checklist V6-15), and again on an assembled leg under the robot\'s own weight (checklist V6-26). The two will differ, and the loaded figure is the useful one.',
    ],
    checklistStep: 'V6-15',
    closesIssues: ['unresolved:servo-model'],
  }),

  powerOnCommandedDeg: carried(90, {
    source: '@sesame-lab/sesame-sim resolveOptions().powerOnDeg',
    method:
      'A simulation choice forced by the API shape: RobotState.commandedDeg is a required number, so some value must appear before anything is commanded. 90 is the assembly datum, not an observation. SimulatedRobotState.simulated.everCommanded is how a UI tells "commanded to 90" from "never commanded", and apps/web deliberately shows null instead.',
    wouldBeConfirmedBy: [
      'Powering a built robot without commanding anything and reading the link angles (checklist V6-13).',
    ],
    checklistStep: 'V6-13',
    closesIssues: [ISSUE_JOINT_MAP],
  }),

  walkDirectionMatchesDrawnFront: carried(null, {
    source: 'hardware/joint-map.json unresolved[walk-direction-vs-drawn-front]',
    method:
      'The CAD fixes which end of the chassis is the front - USB-C aft, OLED and notch forward - but says nothing about which way the gait travels. Null rather than true, because assuming a quadruped walks toward its face is exactly the kind of plausible inference this project refuses to make.',
    wouldBeConfirmedBy: [
      'Running the walk command on a built robot on the floor and watching which end leads (checklist V6-24). Ten seconds, once the robot can stand.',
    ],
    checklistStep: 'V6-24',
    closesIssues: [ISSUE_JOINT_MAP, 'unresolved:walk-direction-vs-drawn-front'],
  }),

  oledActivePlaneMm: carried({ widthMm: 23.6, heightMm: 11.8 }, {
    source: 'assets/sesame.glb oled_screen — docs/findings/V2-gltf-pipeline.md section 6',
    method:
      'The 23.60 mm width is an exact CAD reading of the glass window in the STEP. The 11.80 mm HEIGHT IS A DECISION OF V2, chosen to make the framebuffer a 2:1 rectangle; the CAD glass is 23.60 x 13.70 mm and a real 0.96" SSD1306\'s lit area is smaller than its glass. The face is therefore probably drawn slightly too large.',
    wouldBeConfirmedBy: [
      'Callipers across the lit area of a powered panel showing an all-pixels-on test pattern (checklist V6-05). Needs only the OLED module and something to drive it - no assembled robot.',
    ],
    checklistStep: 'V6-05',
    closesIssues: [],
    note: 'Changing this does NOT resize the quad in assets/sesame.glb, whose geometry is baked. See docs/findings/V6-calibration-and-hardware-checklist.md section 5.',
  }),

  spinQuantumMs: carried(1, {
    source: '@sesame-lab/sesame-sim resolveOptions().spinQuantumMs',
    method:
      'A simulation choice with NO firmware period behind it: pressingCheck() spins on a bare yield() with no delay at all (sesame-firmware-main.ino:1064), unlike delayWithFace() whose delay(5) is a genuine firmware constant. 1 ms was chosen because it flips a face frame within a millisecond of when it is due while costing 100 iterations per 100 ms window instead of a million.',
    wouldBeConfirmedBy: [
      'Instrumenting the real loop on silicon - a GPIO toggle per iteration on a scope, or a micros() histogram - to find the actual iteration rate (checklist V6-08). A bare ESP32 is enough.',
    ],
    checklistStep: 'V6-08',
    closesIssues: [ISSUE_SILICON],
  }),

  loopQuantumMs: carried(1, {
    source: '@sesame-lab/sesame-sim resolveOptions().loopQuantumMs',
    method:
      'A simulation choice, same reason: loop() has no delay in it either, so it has no firmware-defined period.',
    wouldBeConfirmedBy: [
      'The same instrumented run as spinQuantumMs (checklist V6-08). A bare ESP32 is enough.',
    ],
    checklistStep: 'V6-08',
    closesIssues: [ISSUE_SILICON],
  }),
};

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

const JOINT_FIELD_COUNT = 9;
const ROBOT_FIELD_COUNT = Object.keys(robot).length;
const totalFieldCount = joints.length * JOINT_FIELD_COUNT + ROBOT_FIELD_COUNT;

for (const j of joints) {
  const n = Object.keys(j).length - 2; // minus firmwareName, firmwareIndex
  if (n !== JOINT_FIELD_COUNT) {
    throw new Error(`${j.firmwareName} has ${n} calibratable fields, expected ${JOINT_FIELD_COUNT}`);
  }
}

const document = {
  $schema: './calibration.schema.json',
  meta: {
    schemaVersion: SCHEMA_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    task: 'Phase 1 · V6 — calibration layer',
    robotId: 'reference-uncalibrated',
    generatedAt,
    generatedBy: 'scripts/build-calibration.mjs',
    regenerateWith: 'pnpm build:calibration',
    validateWith: 'pnpm validate:calibration',
    layersOver: {
      path: 'hardware/joint-map.json',
      jointMapVersion: jointMap.meta.jointMapVersion,
      sha256: jointMapSha,
      note:
        'This document LAYERS OVER the joint map; it does not fork it. Identity (firmwareName, firmwareIndex, pins, kind), geometry (rotationAxis, pivotOrigin, cadPose) and the firmware clamp stay in joint-map.json and are not repeated here. Only hardware-gated values appear here, and every carried-forward one is re-derived from the joint map by the validator.',
    },
    epistemicContract:
      'Every field is either measured:false (a carried-forward default, equal to today\'s value, with the method and what would settle it) or measured:true (with a timestamp, an operator, a ROBOT SERIAL, an instrument and a procedure step). A carried-forward value may not differ from the design value it layers over: you cannot change a number without claiming you measured it, and you cannot claim you measured it without naming a robot. Nothing in this document has been measured.',
    calibrationStatus: 'uncalibrated',
    measuredFieldCount: 0,
    totalFieldCount,
    checklist: CHECKLIST,
    consumers: [
      '@sesame-lab/sesame-model (CalibrationView; loadCalibration from ./node)',
      '@sesame-lab/sesame-sim (via CalibrationView.toSimOptions() — subtrim, power-on angle, slew, loop quanta)',
      'apps/web (via CalibrationView.toRigCalibration() — not yet wired; see V6 findings section 6)',
    ],
  },

  session: null,

  joints,
  robot,

  unresolved: [
    {
      id: 'horn-spline-quantisation',
      subject: 'Per-build horn angular offset, quantised at 360/teeth',
      status: 'open',
      reason:
        'Unreachable from CAD by construction: the CAD models the design, and this is an artefact of one assembly. Carried here as hornSplineOffsetDeg, defaulting to zero.',
      resolvedBy: 'Measuring the link angle at commanded 90 deg on a specific robot before subtrim.',
      checklistStep: 'V6-20',
      issues: [ISSUE_JOINT_MAP],
    },
    {
      id: 'per-robot-subtrim',
      subject: 'servoSubtrim[8] for a specific build',
      status: 'open',
      reason:
        'Per-build by construction and never persisted by the stock firmware. F6 was explicit that this must not be merged into joint-map.json; this document is the artefact it asked for.',
      resolvedBy: 'A calibration run on a specific robot.',
      checklistStep: 'V6-20',
      issues: [ISSUE_JOINT_MAP],
    },
    {
      id: 'parts-installed-where-drawn',
      subject: 'Whether the part engraved with a joint name sits on that servo channel',
      status: 'open',
      reason:
        'R1 = L2, R2 = L1, R3 = L4 and R4 = L3 are identical solids, so a builder can swap two and nothing in the firmware, the CAD or the geometry would notice. The last remaining gap in all eight semanticName entries.',
      resolvedBy: 'Reading the engravings on a built robot.',
      checklistStep: 'V6-02',
      issues: [ISSUE_JOINT_MAP],
    },
    {
      id: 'mechanical-travel-limits',
      subject: 'The real per-joint travel the printed linkage allows',
      status: 'open',
      reason:
        'The firmware clamp 0..180 is authoritative and is NOT a travel limit. V0 reconstructed one pose and swept nothing.',
      resolvedBy: 'A slow instrumented sweep on an elevated robot, or a collision study on repaired meshes.',
      checklistStep: 'V6-22',
      issues: [ISSUE_JOINT_MAP],
    },
    {
      id: 'walk-direction-vs-drawn-front',
      subject: 'Whether the gait travels toward the CAD front',
      status: 'open',
      reason: 'The CAD fixes which end is which; it cannot say which way the robot goes.',
      resolvedBy: 'Running walk on a built robot.',
      checklistStep: 'V6-24',
      issues: [ISSUE_JOINT_MAP],
    },
    {
      id: 'servo-model-is-sg90-not-mg90s',
      subject: 'Which servo is actually fitted',
      status: 'open',
      reason: 'The CAD models an SG90; the BOM calls for MG90S. Slew, torque and spline all depend on the answer.',
      resolvedBy: 'Reading the label on one servo.',
      checklistStep: 'V6-04',
      issues: [],
    },
    {
      id: 'power-on-servo-angle',
      subject: 'Where the horns sit when setup() attaches without commanding',
      status: 'open',
      reason:
        'Not determined by hardware-map.json or by the firmware. V1 named it the one value a robot and a protractor would settle in about ten seconds.',
      resolvedBy: 'Powering a built robot and looking at it.',
      checklistStep: 'V6-13',
      issues: [ISSUE_JOINT_MAP],
    },
    {
      id: 'servo-angle-gain',
      subject: 'Whether 732..2929 us really maps to 0..180 mechanical degrees',
      status: 'open',
      reason:
        'An assumption V0\'s absolute-sense fit rests on, stated but never checked. The window is unusual enough to be worth a bench test.',
      resolvedBy: 'A bench servo, a horn and a protractor.',
      checklistStep: 'V6-14',
      issues: [],
    },
    {
      id: 'simulated-loop-quanta',
      subject: 'The real iteration rate of pressingCheck() and loop() on silicon',
      status: 'open',
      reason:
        'Both spin with no delay, so neither has a firmware-defined period. 1 ms is a simulation choice with nothing behind it.',
      resolvedBy: 'A GPIO toggle on a scope, or a micros() histogram, on a bare ESP32.',
      checklistStep: 'V6-08',
      issues: [ISSUE_SILICON],
    },
    {
      id: 'oled-active-plane',
      subject: 'The lit area of the 0.96" SSD1306',
      status: 'partially-resolved',
      reason:
        'The 23.60 mm width is an exact CAD reading; the 11.80 mm height is a decision of V2. A real panel\'s active area is smaller than its glass.',
      resolvedBy: 'Callipers across a lit test pattern.',
      checklistStep: 'V6-05',
      issues: [],
    },
  ],
};

const rendered = `${JSON.stringify(document, null, 2)}\n`;

if (check) {
  const current = readFileSync(OUT_PATH, 'utf8').replaceAll('\r\n', '\n');
  if (current !== rendered) {
    console.error(`FAIL  ${rel(OUT_PATH)} is not what scripts/build-calibration.mjs would generate.`);
    console.error('      Run `pnpm build:calibration` (hand edits to the generated document are not supported;');
    console.error('      real calibration data belongs in a per-robot copy, or an override at run time).');
    process.exit(1);
  }
  console.log(`OK    ${rel(OUT_PATH)} matches a fresh generation`);
  process.exit(0);
}

writeFileSync(OUT_PATH, rendered, 'utf8');
console.log(
  `OK    wrote ${rel(OUT_PATH)} — ${joints.length} joints x ${JOINT_FIELD_COUNT} fields + ${ROBOT_FIELD_COUNT} whole-robot fields `
  + `= ${totalFieldCount} hardware-gated values, 0 measured; layered over joint-map ${jointMap.meta.jointMapVersion} (${jointMapSha.slice(0, 16)}…)`,
);
