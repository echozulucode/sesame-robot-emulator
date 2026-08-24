#!/usr/bin/env node
/**
 * Validates hardware/calibration.json — the V6 calibration layer.
 *
 * Five layers, in increasing order of how much they would embarrass us:
 *
 *  1. JSON Schema (draft 2020-12, ajv strict). additionalProperties is false
 *     throughout. The `calibratedValue` oneOf is the guess barrier expressed in
 *     data: the carried-forward branch FORBIDS every measurement attribution
 *     field and the measured branch REQUIRES all of them, so no document can
 *     sit between the two states.
 *
 *  2. Structure. Eight joints in firmware enum order, indices matching
 *     positions, every field of the vocabulary present, subtrim inside the
 *     firmware's -90..+90.
 *
 *  3. Layering. hardware/joint-map.json is re-hashed off disk and must match
 *     meta.layersOver.sha256, and EVERY carried-forward value is re-derived
 *     from the joint map (or from the documented simulation default) and must
 *     still equal it. This is the mechanism that makes the layer honest: you
 *     cannot change a hardware-gated number without also marking it measured,
 *     and you cannot mark it measured without naming a robot.
 *
 *  4. Epistemic invariants. measured:false may not carry attribution, may not
 *     have an empty wouldBeConfirmedBy, and may not use prose that claims an
 *     observation. measured:true requires a timestamp, an operator, a robot
 *     serial, an instrument and a session. meta.calibrationStatus and the
 *     field counts are RECOMPUTED, never trusted.
 *
 *  5. Cross-document. Every checklistStep must exist as a step in
 *     docs/findings/V6-hardware-verification-checklist.md, and every
 *     ISSUE-shaped entry in closesIssues must exist in docs/issues.yaml. A
 *     calibration field that points at a procedure nobody wrote is worse than
 *     one that points at nothing.
 *
 * For the shipped reference document (robotId "reference-uncalibrated") the
 * generator is additionally re-run with --check, so hand edits to a generated
 * file are a hard failure.
 *
 * Usage:
 *   node scripts/validate-calibration.mjs [calibration.json] [schema.json]
 *   node scripts/validate-calibration.mjs --no-cross-check
 *
 * Exit 0 = valid, 1 = invalid.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const crossCheck = !argv.includes('--no-cross-check');
const positional = argv.filter((a) => !a.startsWith('--'));

const calPath = resolve(repoRoot, positional[0] ?? 'hardware/calibration.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/calibration.schema.json');
const jointMapPath = resolve(repoRoot, 'hardware/joint-map.json');
const checklistPath = resolve(repoRoot, 'docs/findings/V6-hardware-verification-checklist.md');
const issuesPath = resolve(repoRoot, 'docs/issues.yaml');

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`cannot read ${rel(path)}: ${err.message}`);
    return undefined;
  }
}

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const cal = readJson(calPath);
const schema = readJson(schemaPath);

// ---------------------------------------------------------------- layer 1
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(cal)) {
  console.error(`FAIL  ${rel(calPath)} does not satisfy ${rel(schemaPath)}:`);
  for (const e of validate.errors ?? []) {
    console.error(`  - ${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------- layer 2
const JOINT_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'];
const JOINT_FIELDS = [
  'directionSign', 'rotationSenseSign', 'zeroReferenceDeg', 'servoSubtrimDeg',
  'hornSplineOffsetDeg', 'mechanicalLimitsDeg', 'safeTravelDeg', 'powerOnCommandedDeg',
  'partIdentity',
];
const ROBOT_FIELDS = [
  'servoModel', 'hornSplineTeeth', 'angleGainDegPerCommandedDeg', 'slewDegPerSec',
  'powerOnCommandedDeg', 'walkDirectionMatchesDrawnFront', 'oledActivePlaneMm',
  'spinQuantumMs', 'loopQuantumMs',
];
const EXPECTED_FIELD_COUNT = JOINT_ORDER.length * JOINT_FIELDS.length + ROBOT_FIELDS.length;

cal.joints.forEach((j, i) => {
  check(j.firmwareName === JOINT_ORDER[i],
    `joints[${i}] is "${j.firmwareName}" but firmware enum order requires "${JOINT_ORDER[i]}". Calibration is keyed on the servo channel; re-sorting it calibrates the wrong motor.`);
  check(j.firmwareIndex === i, `${j.firmwareName}: firmwareIndex ${j.firmwareIndex} != array position ${i}`);
  for (const f of JOINT_FIELDS) check(f in j, `${j.firmwareName}: missing field "${f}"`);
  const sub = j.servoSubtrimDeg?.value;
  check(typeof sub === 'number' && sub >= -90 && sub <= 90,
    `${j.firmwareName}: servoSubtrimDeg ${sub} outside the firmware's -90..90 (sesame-firmware-main.ino:851)`);
});
for (const f of ROBOT_FIELDS) check(f in cal.robot, `robot: missing field "${f}"`);

const allFields = [];
for (const j of cal.joints) for (const f of JOINT_FIELDS) allFields.push([`joints.${j.firmwareName}.${f}`, j[f]]);
for (const f of ROBOT_FIELDS) allFields.push([`robot.${f}`, cal.robot[f]]);

check(allFields.length === EXPECTED_FIELD_COUNT,
  `expected ${EXPECTED_FIELD_COUNT} calibratable fields, found ${allFields.length}`);

// ---------------------------------------------------------------- layer 3
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

if (crossCheck) {
  const jointMapRaw = readFileSync(jointMapPath);
  const sha = createHash('sha256').update(jointMapRaw).digest('hex');
  check(cal.meta.layersOver.sha256 === sha,
    `meta.layersOver.sha256 is ${cal.meta.layersOver.sha256.slice(0, 16)}… but ${rel(jointMapPath)} hashes to ${sha.slice(0, 16)}…. Regenerate with \`pnpm build:calibration\`.`);

  const jointMap = JSON.parse(jointMapRaw.toString('utf8'));
  check(cal.meta.layersOver.jointMapVersion === jointMap.meta.jointMapVersion,
    `meta.layersOver.jointMapVersion is ${cal.meta.layersOver.jointMapVersion}, joint map says ${jointMap.meta.jointMapVersion}`);

  const byName = new Map(jointMap.joints.map((j) => [j.firmwareName, j]));
  for (const j of cal.joints) {
    const src = byName.get(j.firmwareName);
    if (src === undefined) { check(false, `${j.firmwareName}: no such joint in the joint map`); continue; }
    const senseMatch = /=\s*([+-]?1)\s*\*/.exec(src.directionSign.absoluteSense?.rule ?? '');
    const expectations = [
      ['directionSign', src.directionSign.value],
      ['zeroReferenceDeg', src.zeroReferenceDeg.value],
      ['mechanicalLimitsDeg', src.angleLimitsDeg.mechanicalLimitsDeg],
      ['servoSubtrimDeg', 0],
      ['hornSplineOffsetDeg', 0],
      ['safeTravelDeg', null],
      ['powerOnCommandedDeg', null],
      ['partIdentity', null],
      ...(senseMatch === null ? [] : [['rotationSenseSign', Number(senseMatch[1])]]),
    ];
    for (const [field, want] of expectations) {
      const f = j[field];
      if (f?.measured !== false) continue;
      check(same(f.value, want),
        `${j.firmwareName}.${field}: a carried-forward value must equal the design value it layers over (${JSON.stringify(want)}), found ${JSON.stringify(f.value)}. Change it only by marking it measured:true with a robot serial.`);
    }
  }

  const robotDefaults = [
    ['servoModel', 'unknown'],
    ['hornSplineTeeth', 20],
    ['angleGainDegPerCommandedDeg', 1],
    ['slewDegPerSec', 600],
    ['powerOnCommandedDeg', 90],
    ['walkDirectionMatchesDrawnFront', null],
    ['oledActivePlaneMm', { widthMm: 23.6, heightMm: 11.8 }],
    ['spinQuantumMs', 1],
    ['loopQuantumMs', 1],
  ];
  for (const [field, want] of robotDefaults) {
    const f = cal.robot[field];
    if (f?.measured !== false) continue;
    check(same(f.value, want),
      `robot.${field}: a carried-forward value must equal today's documented default (${JSON.stringify(want)}), found ${JSON.stringify(f.value)}. Change it only by marking it measured:true with a robot serial.`);
  }
}

// ---------------------------------------------------------------- layer 4
// Negated wording ("NOT MEASURED on any robot") is the honest phrasing this
// project uses everywhere, so it is stripped before the claim test.
const NEGATED_MEASUREMENT =
  /\b(not|never|nobody\s+has|no\s+one\s+has|cannot\s+be|un)\s*(been\s+)?(measured|observed|verified|calibrated)/gi;
const CLAIMS_OBSERVATION = /\b(measured on|as measured|observed on|verified on|calibrated on)\b/i;
const claimsObservation = (text) =>
  typeof text === 'string' ? CLAIMS_OBSERVATION.exec(text.replace(NEGATED_MEASUREMENT, ' ')) : null;
let measuredCount = 0;
const sessionPresent = cal.session !== null && typeof cal.session === 'object';

for (const [path, f] of allFields) {
  if (f === undefined) continue;
  if (f.measured === false) {
    for (const key of ['measuredAt', 'measuredBy', 'robotSerial', 'instrument']) {
      check(!(key in f), `${path}: a carried-forward value must not carry "${key}" — nothing was measured`);
    }
    check(Array.isArray(f.wouldBeConfirmedBy) && f.wouldBeConfirmedBy.length > 0,
      `${path}: a carried-forward value must say what wouldBeConfirmedBy it`);
    for (const key of ['method', 'source']) {
      const hit = claimsObservation(f[key]);
      check(hit === null, `${path}.${key} claims an observation ("${hit?.[0]}") on a value marked measured:false`);
    }
  } else if (f.measured === true) {
    measuredCount += 1;
    for (const key of ['measuredAt', 'measuredBy', 'robotSerial', 'instrument']) {
      check(typeof f[key] === 'string' && f[key].trim().length > 0,
        `${path}: a measured value must name "${key}". Promoting a guess is a claim about a specific robot, not a data edit.`);
    }
    check(!Number.isNaN(Date.parse(f.measuredAt ?? '')), `${path}: measuredAt must be an ISO-8601 timestamp`);
    check(!('wouldBeConfirmedBy' in f), `${path}: a measured value must not carry wouldBeConfirmedBy — it has been confirmed`);
    check(sessionPresent, `${path}: a measured value requires session to be present`);
  }
}

const expectedStatus =
  measuredCount === 0 ? 'uncalibrated'
    : measuredCount === EXPECTED_FIELD_COUNT ? 'complete'
      : 'partial';
check(cal.meta.calibrationStatus === expectedStatus,
  `meta.calibrationStatus says "${cal.meta.calibrationStatus}" but ${measuredCount} of ${EXPECTED_FIELD_COUNT} fields are measured, which is "${expectedStatus}"`);
check(cal.meta.measuredFieldCount === measuredCount,
  `meta.measuredFieldCount says ${cal.meta.measuredFieldCount}, recomputed ${measuredCount}`);
check(cal.meta.totalFieldCount === EXPECTED_FIELD_COUNT,
  `meta.totalFieldCount says ${cal.meta.totalFieldCount}, expected ${EXPECTED_FIELD_COUNT}`);
check(measuredCount === 0 || sessionPresent, 'measured fields are present but session is null');
check(!sessionPresent || cal.meta.robotId === cal.session.robotSerial,
  `meta.robotId "${cal.meta.robotId}" does not match session.robotSerial "${cal.session?.robotSerial}"`);

// The four things V0 explicitly could not close must still be open here.
const openIds = new Set(cal.unresolved.filter((u) => u.status !== 'resolved').map((u) => u.id));
for (const id of ['horn-spline-quantisation', 'per-robot-subtrim', 'parts-installed-where-drawn', 'mechanical-travel-limits']) {
  check(openIds.has(id), `unresolved[] must still carry "${id}" as open — no hardware has been touched`);
}

if (cal.meta.robotId === 'reference-uncalibrated') {
  check(measuredCount === 0,
    'the shipped reference document claims measured fields. A calibrated robot needs its own document with its own robotId, not an edit to this one.');
  const blob = JSON.stringify(cal);
  check(!/"measured"\s*:\s*true/.test(blob),
    'the reference calibration contains `"measured": true`. Nothing in this project has been measured on a physical robot.');
}

// ---------------------------------------------------------------- layer 5
if (crossCheck) {
  if (existsSync(checklistPath)) {
    const md = readFileSync(checklistPath, 'utf8');
    const steps = new Set([...md.matchAll(/^#+\s+(V6-\d{2}[a-z]?)\b/gm)].map((m) => m[1]));
    check(steps.size > 0, `${rel(checklistPath)} defines no "V6-nn" steps`);
    const referenced = new Set([
      ...allFields.map(([, f]) => f?.checklistStep).filter(Boolean),
      ...cal.unresolved.map((u) => u.checklistStep),
    ]);
    for (const s of [...referenced].sort()) {
      check(steps.has(s), `checklist step "${s}" is referenced by the calibration but is not a step in ${rel(checklistPath)}`);
    }
  } else {
    check(false, `${rel(checklistPath)} is missing; every calibration field points at a step in it`);
  }

  if (existsSync(issuesPath)) {
    const known = new Set([...readFileSync(issuesPath, 'utf8').matchAll(/^\s*-?\s*id:\s*(ISSUE-[\w-]+)/gm)].map((m) => m[1]));
    const cited = new Set();
    for (const [, f] of allFields) for (const c of f?.closesIssues ?? []) if (c.startsWith('ISSUE-')) cited.add(c);
    for (const u of cal.unresolved) for (const c of u.issues ?? []) if (c.startsWith('ISSUE-')) cited.add(c);
    for (const c of [...cited].sort()) {
      check(known.has(c), `closesIssues cites "${c}", which is not in ${rel(issuesPath)}`);
    }
  }

  // The generated reference document must still be what the generator produces.
  if (cal.meta.robotId === 'reference-uncalibrated' && calPath === resolve(repoRoot, 'hardware/calibration.json')) {
    try {
      execFileSync(process.execPath, [resolve(here, 'build-calibration.mjs'), '--check'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
      check(false, `the reference calibration is not what scripts/build-calibration.mjs would generate:\n      ${out.replaceAll('\n', '\n      ')}`);
    }
  }
}

// ---------------------------------------------------------------- report
if (problems.length > 0) {
  console.error(`FAIL  ${rel(calPath)} — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const outstanding = allFields.filter(([, f]) => f?.measured === false).length;
console.log(
  `OK    ${rel(calPath)} — robot "${cal.meta.robotId}", ${EXPECTED_FIELD_COUNT} hardware-gated fields `
  + `(${measuredCount} measured, ${outstanding} carried forward), status "${cal.meta.calibrationStatus}"; `
  + `${cal.unresolved.filter((u) => u.status !== 'resolved').length} unresolved items`
  + (crossCheck
    ? `; layered over joint-map ${cal.meta.layersOver.jointMapVersion}, every carried-forward value re-derived and every checklist step resolved`
    : '; cross-check skipped'),
);
