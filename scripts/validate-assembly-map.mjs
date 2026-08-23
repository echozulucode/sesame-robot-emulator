#!/usr/bin/env node
/**
 * Validate `hardware/assembly-map.json` (V0).
 *
 * Four layers, in increasing order of how much they would actually catch:
 *
 *   1. JSON Schema (draft 2020-12, additionalProperties:false everywhere).
 *   2. Provenance. Every recorded path names the pinned `firmware/upstream/`
 *      tree, and where that tree is materialised the sha256 is re-hashed off
 *      disk. Same rule F5 is held to by validate-assets-inventory.mjs.
 *   3. Geometric self-consistency, RECOMPUTED here rather than trusted: every
 *      part's pose must be orthonormal and right-handed, the canonical frame
 *      matrix must be a proper rotation, the eight joint axes must be unit
 *      vectors, the four hip axes must be vertical and land on the recorded
 *      rectangle, the femur/foot mate graph must be a bijection, and the
 *      kinematic tree must be a forest with no cycles.
 *   4. Epistemic invariants. Nothing may claim `verified: true`; a frameMap
 *      marked "resolved" must actually have won decisively; a pose may only be
 *      `authoritative` if it names a CAD occurrence path; and every claim in
 *      `resolvedByThisTask` must be backed by a check in `assemblyChecks` that
 *      actually passed.
 *
 * Usage: node scripts/validate-assembly-map.mjs [map] [schema]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const mapPath = resolve(repoRoot, positional[0] ?? 'hardware/assembly-map.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/assembly-map.schema.json');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    console.error(`FAIL  cannot read ${rel(p)}: ${e.message}`);
    process.exit(1);
  }
};

const problems = [];
const notes = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const doc = readJson(mapPath);
const schema = readJson(schemaPath);

// ------------------------------------------------------------- 1. schema
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default ? addFormats.default(ajv) : addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(doc)) {
  for (const e of validate.errors ?? []) {
    problems.push(`schema ${e.instancePath || '(root)'}: ${e.message}`);
  }
}

// --------------------------------------------------------- 2. provenance
const PINNED = 'firmware/upstream/';
const VENDORED = 'reference/sesame-robot-main/';
const paths = new Set();
(function collect(node) {
  if (typeof node === 'string') {
    if (node.includes(VENDORED)) problems.push(`path cites the gitignored vendored tree: ${node}`);
    if (node.startsWith(PINNED)) paths.add(node);
    return;
  }
  if (Array.isArray(node)) { node.forEach(collect); return; }
  if (node && typeof node === 'object') { Object.values(node).forEach(collect); }
})(doc);
check(paths.size >= 11, `expected >=11 upstream paths, found ${paths.size}`);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let rehashed = 0;
for (const src of doc.meta.sources) {
  const abs = resolve(repoRoot, src.path);
  if (!existsSync(abs)) continue;
  const got = sha(abs);
  check(got === src.sha256, `sha256 mismatch for ${src.path}: recorded ${src.sha256}, on disk ${got}`);
  rehashed += 1;
}
for (const part of doc.parts) {
  const abs = resolve(repoRoot, part.stlPath);
  if (!existsSync(abs)) continue;
  const got = sha(abs);
  check(got === part.stlSha256, `sha256 mismatch for ${part.stlPath}`);
  rehashed += 1;
}
notes.push(`re-hashed ${rehashed} source file(s) present on disk`);

// Cross-check against F5: the STL sha256 recorded here must be the one F5 measured.
const invPath = resolve(repoRoot, 'hardware/assets-inventory.json');
if (existsSync(invPath)) {
  const inv = readJson(invPath);
  const byFile = new Map(inv.parts.map((p) => [p.file, p]));
  for (const part of doc.parts) {
    const f5 = byFile.get(part.stlFile);
    check(!!f5, `part ${part.id} names ${part.stlFile}, absent from assets-inventory.json`);
    if (f5) {
      check(f5.sha256 === part.stlSha256, `part ${part.id}: sha256 disagrees with F5`);
      check(f5.path === part.stlPath, `part ${part.id}: path disagrees with F5`);
    }
  }
  notes.push(`cross-checked ${doc.parts.length} STL identities against F5`);
}

// ---------------------------------------------- 3. geometric self-consistency
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const col = (M, j) => [M[0][j], M[1][j], M[2][j]];

const orthonormalRightHanded = (M, label) => {
  const x = col(M, 0), y = col(M, 1), z = col(M, 2);
  for (const [v, n] of [[x, 'x'], [y, 'y'], [z, 'z']]) {
    check(near(norm(v), 1, 1e-6), `${label}: ${n} axis is not unit (|${n}| = ${norm(v)})`);
  }
  check(near(dot(x, y), 0, 1e-6), `${label}: x.y = ${dot(x, y)}`);
  check(near(dot(y, z), 0, 1e-6), `${label}: y.z = ${dot(y, z)}`);
  check(near(dot(x, z), 0, 1e-6), `${label}: x.z = ${dot(x, z)}`);
  check(near(dot(cross(x, y), z), 1, 1e-6),
    `${label}: not right-handed (det = ${dot(cross(x, y), z)})`);
  check(M[3][0] === 0 && M[3][1] === 0 && M[3][2] === 0 && M[3][3] === 1,
    `${label}: bottom row is not [0,0,0,1]`);
};

orthonormalRightHanded(doc.canonicalFrame.canonicalFromCadRootMm, 'canonicalFromCadRootMm');
for (const p of doc.parts) {
  orthonormalRightHanded(p.poseFromStlMm, `parts[${p.id}].poseFromStlMm`);
  // the flattened axis/origin fields must agree with the matrix
  const M = p.poseFromStlMm;
  const pairs = [['xAxis', col(M, 0)], ['yAxis', col(M, 1)], ['zAxis', col(M, 2)],
                 ['originMm', [M[0][3], M[1][3], M[2][3]]]];
  for (const [field, want] of pairs) {
    const got = p[field];
    check(want.every((v, i) => near(v, got[i], 1e-5)),
      `parts[${p.id}].${field} disagrees with poseFromStlMm`);
  }
}

const UP = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const up = UP[doc.canonicalFrame.upAxis];
const fwd = UP[doc.canonicalFrame.forwardAxis];
const right = UP[doc.canonicalFrame.rightAxis];
check(near(dot(up, fwd), 0, 1e-9) && near(dot(up, right), 0, 1e-9) && near(dot(fwd, right), 0, 1e-9),
  'canonicalFrame: up/forward/right are not mutually perpendicular');
check(near(dot(cross(fwd, up), right), 1, 1e-9),
  'canonicalFrame: right != forward x up, so the declared frame is not right-handed');

// joints
const hips = doc.joints.filter((j) => j.kind === 'femur');
const feet = doc.joints.filter((j) => j.kind === 'foot');
check(hips.length === 4 && feet.length === 4, 'expected 4 femur joints and 4 foot joints');
for (const j of doc.joints) {
  check(near(norm(j.axisUnitVector), 1, 1e-5), `joint ${j.firmwareJointName}: axis is not unit`);
  if (j.servoShaftAxis) {
    check(near(norm(j.servoShaftAxis), 1, 1e-5),
      `joint ${j.firmwareJointName}: servo shaft axis is not unit`);
    check(near(Math.abs(dot(j.servoShaftAxis, j.axisUnitVector)), 1, 1e-5),
      `joint ${j.firmwareJointName}: servo shaft axis is not parallel to the joint axis`);
    check(j.cadServoAgreementMm !== null && j.cadServoAgreementMm < 0.01,
      `joint ${j.firmwareJointName}: servo shaft is ${j.cadServoAgreementMm} mm off the joint axis`);
  } else {
    check(j.servoShaftStatus === 'absent-from-cad',
      `joint ${j.firmwareJointName}: no servo shaft but status is ${j.servoShaftStatus}`);
  }
}
for (const j of hips) {
  check(near(Math.abs(dot(j.axisUnitVector, up)), 1, 1e-6),
    `hip ${j.firmwareJointName}: axis is not vertical`);
  check(near(dot(j.pointOnAxisMm, up), 0, 1e-4),
    `hip ${j.firmwareJointName}: axis point is not in the origin plane`);
}
for (const j of feet) {
  check(near(dot(j.axisUnitVector, up), 0, 1e-6),
    `knee ${j.firmwareJointName}: axis is not horizontal`);
}

// hip rectangle, recomputed
const rectAxis = (unit) => {
  const vals = hips.map((j) => Math.round(dot(j.pointOnAxisMm, unit) * 1e3) / 1e3);
  return Math.max(...vals) - Math.min(...vals);
};
const hr = doc.assemblyChecks.hipAxisRectangle;
check(near(rectAxis(right), hr.leftRightSpacingMm, 1e-3),
  `hipAxisRectangle.leftRightSpacingMm ${hr.leftRightSpacingMm} != recomputed ${rectAxis(right)}`);
check(near(rectAxis(fwd), hr.foreAftSpacingMm, 1e-3),
  `hipAxisRectangle.foreAftSpacingMm ${hr.foreAftSpacingMm} != recomputed ${rectAxis(fwd)}`);
check(near(hr.leftRightSpacingMm, 50.8, 1e-3),
  `hip left/right spacing ${hr.leftRightSpacingMm} is not the CAD's exact 2.000 in`);
check(near(hr.foreAftSpacingMm, 38.1 + 2 * 5.15, 1e-3),
  `hip fore/aft spacing ${hr.foreAftSpacingMm} is not 1.500 in + 2 x 5.15 mm shaft offset`);

// mate graph is a bijection, and the recorded joints agree with it
const mates = doc.assemblyChecks.kneeCoaxiality.matedPairs;
check(new Set(Object.values(mates)).size === 4, 'mated pairs are not a bijection');
for (const j of feet) {
  check(mates[j.parentPart] === j.firmwareJointName,
    `joint ${j.firmwareJointName}: parentPart ${j.parentPart} contradicts matedPairs`);
}
// kinematic tree: femurs parent to the frame, feet to a femur, no cycles
const byName = new Map(doc.joints.map((j) => [j.firmwareJointName, j]));
for (const j of doc.joints) {
  const seen = new Set([j.firmwareJointName]);
  let cur = j.parentPart;
  while (byName.has(cur)) {
    check(!seen.has(cur), `kinematic cycle through ${cur}`);
    seen.add(cur);
    cur = byName.get(cur).parentPart;
  }
  check(cur === 'internal-frame', `joint ${j.firmwareJointName}: chain does not root at internal-frame`);
}
// every joint names a part that exists
const partIds = new Set(doc.parts.map((p) => p.id));
for (const j of doc.joints) {
  check(partIds.has(j.childPart), `joint ${j.firmwareJointName}: unknown childPart ${j.childPart}`);
  check(partIds.has(j.parentPart), `joint ${j.firmwareJointName}: unknown parentPart ${j.parentPart}`);
}

// feet reach below the chassis, and the body shells stack with no gap
const stack = doc.assemblyChecks.bodyShellStack;
check(near(stack.bottomMeetsFrameGapMm, 0, 1e-4),
  `bottom cover does not meet the internal frame (${stack.bottomMeetsFrameGapMm} mm)`);
check(near(stack.frameMeetsTopGapMm, 0, 1e-4),
  `internal frame does not meet the top cover (${stack.frameMeetsTopGapMm} mm)`);
check(doc.canonicalFrame.groundPlaneYMm < stack.bottomCoverY[0],
  'the feet do not reach below the bottom cover, so the up axis is upside down');
for (const f of doc.assemblyChecks.feetVertical) {
  const axisName = ['+X', '-X'].includes(doc.canonicalFrame.upAxis) ? 'x'
    : ['+Y', '-Y'].includes(doc.canonicalFrame.upAxis) ? 'y' : 'z';
  check(f.longAxis === axisName, `foot ${f.foot} is not vertical in the reference pose`);
}

// -------------------------------------------------- 4. epistemic invariants
const raw = readFileSync(mapPath, 'utf8');
check(!/"verified"\s*:\s*true/.test(raw), 'a "verified": true escaped into the assembly map');

const fm = doc.frameMap;
if (fm.result === 'resolved') {
  check(fm.candidateSearch.decisive,
    'frameMap says "resolved" but the candidate search was not decisive');
  check(fm.candidateSearch.marginRatio >= 100,
    `frameMap says "resolved" on a margin of only ${fm.candidateSearch.marginRatio}x`);
  check(fm.candidateSearch.winner.score < 0.05,
    `frameMap winner residual ${fm.candidateSearch.winner.score} mm is too large to call resolved`);
  const w = fm.candidateSearch.winner;
  check(near(w.scale, fm.map.scale, 1e-9), 'frameMap.map.scale disagrees with the winner');
  for (const r of fm.candidateSearch.perPartResiduals) {
    check(r.maxResidualMm < 1.0,
      `part ${r.partId} has a ${r.maxResidualMm} mm worst-case registration residual`);
  }
} else {
  check(!doc.resolvedByThisTask.some((r) => r.id === 'stl-to-cad-frame-mapping'),
    'frameMap is ambiguous but stl-to-cad-frame-mapping is claimed resolved');
}

for (const p of doc.parts) {
  if (p.poseStatus === 'authoritative') {
    check(typeof p.cadOccurrencePath === 'string' && p.cadOccurrencePath.length > 0,
      `part ${p.id} claims an authoritative pose without a CAD occurrence path`);
    check(typeof p.cadProduct === 'string',
      `part ${p.id} claims an authoritative pose without a CAD product name`);
  } else {
    check(p.cadOccurrencePath === null,
      `part ${p.id} has a CAD occurrence but does not claim an authoritative pose`);
    check(/NOT IN THE CAD ASSEMBLY/.test(p.poseMethod),
      `part ${p.id} has an inferred pose whose method does not say why`);
  }
}

// claims must be backed by checks that passed
const claimed = new Set(doc.resolvedByThisTask.map((r) => r.id));
const backing = {
  'stl-to-cad-frame-mapping': () => fm.result === 'resolved',
  'per-instance-assembly-poses': () =>
    doc.parts.filter((p) => p.poseStatus === 'authoritative').length >= 10,
  'hip-to-foot-instance-naming': () =>
    doc.assemblyChecks.kneeCoaxiality.separationRatio >= 50,
  'front-rear-orientation': () =>
    !!doc.canonicalFrame.axisEvidence.forward.usbPortBbox
    && !!doc.canonicalFrame.axisEvidence.forward.oledScreenBbox,
  'rest-pose-hip-orientation-contradiction': () =>
    doc.referencePose.restPoseGeometry.allFourLegsParallelToBodyLongAxis === true,
  'absolute-rotational-sense': () =>
    doc.referencePose.hipRuleFit.determined === true
    && doc.referencePose.kneeRuleFit.determined === true,
  'servo-datum-plane': () =>
    doc.joints.filter((j) => j.servoShaftStatus === 'authoritative').length >= 4,
  'view-direction-of-the-labelled-drawings': () =>
    doc.canonicalFrame.axisEvidence.right.status === 'inferred',
};
for (const id of claimed) {
  const fn = backing[id];
  check(!!fn, `resolvedByThisTask claims "${id}" with no backing check in the validator`);
  if (fn) check(fn(), `resolvedByThisTask claims "${id}" but its backing check does not pass`);
}

// interpenetration must actually be zero if the assembly is being called consistent
check(doc.assemblyChecks.interpenetration.maxPenetrationMm < 0.05,
  `parts interpenetrate by up to ${doc.assemblyChecks.interpenetration.maxPenetrationMm} mm`);

// these must never be silently closed
const MUST_STAY_OPEN = ['horn-spline-quantisation', 'mechanical-travel-limits',
  'per-robot-subtrim', 'parts-installed-where-drawn'];
const open = new Set(doc.unresolved.map((u) => u.id));
for (const id of MUST_STAY_OPEN) {
  check(open.has(id), `"${id}" must stay in unresolved[]; V0 cannot close it`);
  check(!claimed.has(id), `"${id}" is claimed resolved, which V0 cannot do`);
}

// -------------------------------------------------------------------- report
if (problems.length) {
  console.error(`FAIL  ${rel(mapPath)}  (${problems.length} problem${problems.length > 1 ? 's' : ''})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.error(`OK    ${rel(mapPath)}`);
console.error(`      ${doc.parts.length} parts, ${doc.joints.length} joints, `
  + `${doc.servos.length} servos; frame map ${fm.result} at `
  + `${fm.candidateSearch.marginRatio}x margin`);
for (const n of notes) console.error(`      ${n}`);
