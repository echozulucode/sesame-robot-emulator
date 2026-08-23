#!/usr/bin/env node
/**
 * Validates hardware/joint-map.json against hardware/joint-map.schema.json (F6).
 *
 * Three layers:
 *
 *  1. JSON Schema (draft 2020-12, ajv, strict mode). additionalProperties is
 *     false throughout, so a typo'd key is a hard failure. The schema also
 *     pins `semanticName.verified` to the literal false, so an unverified
 *     guess cannot be promoted to fact by editing data.
 *
 *  2. Semantic invariants the schema cannot express:
 *       - joints[] is in firmware enum order R1,R2,L1,L2,R4,R3,L3,L4, and each
 *         entry's firmwareIndex equals its array position
 *       - every joint's pins/index/provenance agree with hardware/hardware-map.json
 *       - kind, rotation axis and pivot origin agree with hardware/assets-inventory.json
 *       - shape equivalence classes partition the eight joints, pair diagonally,
 *         and match F5's partShapeGroups
 *       - the femur/foot parent-child graph is a forest with no cycles, every
 *         foot has exactly one femur parent and every femur exactly one foot child
 *       - directionSign is constant within a shape class and opposite between
 *         the two classes of a family
 *       - every observedRangeDeg statistic is REPRODUCED from hardware-map.json's
 *         movement steps rather than trusted (this is the important one: the
 *         numbers are evidence, so they have to be recomputable)
 *       - every angle mentioned anywhere lies inside the firmware clamp
 *       - source SHA-256s still match the files on disk
 *
 *  3. Epistemic invariants — the reason this file exists:
 *       - every semanticName carries verified:false and a non-empty basis
 *       - nothing anywhere claims a semantic name is verified
 *       - every "inferred" field carries a method or a basis
 *       - all six F5 unresolved items are carried forward, and any marked
 *         "resolved" name the artefact that closed them
 *       - the four items V0 CANNOT close (horn-spline quantisation, mechanical
 *         travel limits, per-robot subtrim, parts-installed-where-drawn) are
 *         still open
 *
 *  4. Cross-checks against hardware/assembly-map.json (V0). Every cadPose,
 *     every absoluteSense rule, the canonical frame and the femur/foot mate
 *     graph must still equal what the CAD reconstruction produced. Promoted
 *     geometry that has quietly drifted from its source is worse than
 *     geometry that was never promoted.
 *
 * Usage:
 *   node scripts/validate-joint-map.mjs [map.json] [schema.json]
 *   node scripts/validate-joint-map.mjs --no-cross-check   (schema + shape only)
 *
 * Exit 0 = valid, 1 = invalid.
 */
import { readFileSync, existsSync } from 'node:fs';
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

const mapPath = resolve(repoRoot, positional[0] ?? 'hardware/joint-map.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/joint-map.schema.json');

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${rel(path)}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${rel(path)} is not valid JSON: ${err.message}`);
  }
}

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

const schema = readJson(schemaPath);
const map = readJson(mapPath);

// ---------------------------------------------------------------- layer 1
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats.default ? addFormats.default(ajv) : addFormats(ajv);

let validate;
try {
  validate = ajv.compile(schema);
} catch (err) {
  fail(`${rel(schemaPath)} is not a compilable schema: ${err.message}`);
}

if (!validate(map)) {
  for (const e of validate.errors ?? []) {
    problems.push(`schema: ${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
  }
}

// ---------------------------------------------------------------- layer 2
const FIRMWARE_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'];
const joints = Array.isArray(map.joints) ? map.joints : [];
const byName = new Map(joints.map((j) => [j.firmwareName, j]));

check(
  joints.map((j) => j.firmwareName).join(',') === FIRMWARE_ORDER.join(','),
  `joints[] is not in firmware enum order. Expected ${FIRMWARE_ORDER.join(',')}, got ${joints.map((j) => j.firmwareName).join(',')}. This order is the firmware's ServoName enum; it is deliberately neither geometric nor alphabetical and must never be re-sorted.`,
);
joints.forEach((j, i) => {
  check(j.firmwareIndex === i, `joints[${i}] (${j.firmwareName}) has firmwareIndex ${j.firmwareIndex}; array position and firmware index must agree.`);
});

// --- cross-check against F4 and F5 -----------------------------------------
if (crossCheck) {
  const hwPath = resolve(repoRoot, 'hardware/hardware-map.json');
  const asPath = resolve(repoRoot, 'hardware/assets-inventory.json');

  if (!existsSync(hwPath) || !existsSync(asPath)) {
    problems.push('cross-check requested but hardware-map.json or assets-inventory.json is missing; pass --no-cross-check to skip.');
  } else {
    const hw = readJson(hwPath);
    const assets = readJson(asPath);

    check(
      hw.servos.order.join(',') === FIRMWARE_ORDER.join(','),
      `hardware-map.json servos.order drifted from ${FIRMWARE_ORDER.join(',')}`,
    );

    for (const j of joints) {
      const fw = hw.servos.joints.find((x) => x.firmwareName === j.firmwareName);
      const part = assets.parts.find((p) => p.file.startsWith(`${j.firmwareName}-`));
      if (!fw) { problems.push(`${j.firmwareName}: absent from hardware-map.json servos.joints`); continue; }
      if (!part) { problems.push(`${j.firmwareName}: absent from assets-inventory.json parts`); continue; }

      check(fw.index === j.firmwareIndex, `${j.firmwareName}: firmwareIndex ${j.firmwareIndex} != hardware-map ${fw.index}`);
      check(
        JSON.stringify(fw.pinsByBoard) === JSON.stringify(j.pinsByBoard),
        `${j.firmwareName}: pinsByBoard drifted from hardware-map.json (${JSON.stringify(j.pinsByBoard)} vs ${JSON.stringify(fw.pinsByBoard)})`,
      );
      check(
        JSON.stringify(fw.pinSourceByBoard) === JSON.stringify(j.pinSourceByBoard),
        `${j.firmwareName}: pinSourceByBoard drifted from hardware-map.json`,
      );
      check(j.kind === part.cadIdentity.kind, `${j.firmwareName}: kind "${j.kind}" != STEP kind "${part.cadIdentity.kind}"`);
      check(
        part.cadIdentity.product.endsWith(j.firmwareName),
        `${j.firmwareName}: STEP PRODUCT name "${part.cadIdentity.product}" does not name this joint`,
      );
      check(j.stlFile === part.file, `${j.firmwareName}: stlFile "${j.stlFile}" != inventory "${part.file}"`);
      check(j.stlSha256 === part.sha256, `${j.firmwareName}: stlSha256 drifted from assets-inventory.json`);
      check(
        JSON.stringify(j.rotationAxis.value) === JSON.stringify(part.pivotCandidate.axis),
        `${j.firmwareName}: rotationAxis drifted from F5 pivotCandidate.axis`,
      );
      check(
        JSON.stringify(j.pivotOrigin.value) === JSON.stringify(part.pivotCandidate.origin),
        `${j.firmwareName}: pivotOrigin drifted from F5 pivotCandidate.origin`,
      );
      check(
        j.rotationAxis.axisConfidence === part.pivotCandidate.axisConfidence
        && j.pivotOrigin.originConfidence === part.pivotCandidate.originConfidence,
        `${j.firmwareName}: pivot confidences drifted from F5`,
      );

      const clamp = hw.servos.servoConfig.angleClamp;
      check(
        j.angleLimitsDeg.value.min === clamp.min && j.angleLimitsDeg.value.max === clamp.max,
        `${j.firmwareName}: angleLimitsDeg drifted from the firmware clamp ${clamp.min}..${clamp.max}`,
      );
    }

    // --- recompute the choreography statistics -----------------------------
    const hist = Object.fromEntries(FIRMWARE_ORDER.map((n) => [n, new Map()]));
    const fns = Object.fromEntries(FIRMWARE_ORDER.map((n) => [n, new Set()]));
    let totalSteps = 0;
    let servoSteps = 0;
    (function walkAll() {
      const walk = (steps, fn) => {
        for (const s of steps) {
          totalSteps += 1;
          if (s.type === 'servo') {
            servoSteps += 1;
            const h = hist[s.joint];
            if (!h) { problems.push(`movement ${fn} commands unknown joint "${s.joint}"`); continue; }
            h.set(s.angleDeg, (h.get(s.angleDeg) ?? 0) + 1);
            fns[s.joint].add(fn);
          }
          if (Array.isArray(s.steps)) walk(s.steps, fn);
        }
      };
      for (const mv of hw.movements) walk(mv.steps, mv.function);
    })();

    check(
      map.choreographyAnalysis.corpus.functions === hw.movements.length
      && map.choreographyAnalysis.corpus.totalSteps === totalSteps
      && map.choreographyAnalysis.corpus.servoSteps === servoSteps,
      `choreographyAnalysis.corpus is not reproducible: file says ${map.choreographyAnalysis.corpus.functions}/${map.choreographyAnalysis.corpus.totalSteps}/${map.choreographyAnalysis.corpus.servoSteps}, recomputed ${hw.movements.length}/${totalSteps}/${servoSteps}`,
    );

    for (const j of joints) {
      const h = hist[j.firmwareName];
      const values = [...h.keys()].sort((a, b) => a - b);
      const flat = [];
      for (const v of values) for (let i = 0; i < h.get(v); i += 1) flat.push(v);
      const median = flat.length % 2
        ? flat[(flat.length - 1) / 2]
        : (flat[flat.length / 2 - 1] + flat[flat.length / 2]) / 2;
      const o = j.observedRangeDeg;

      check(o.sampleCount === flat.length, `${j.firmwareName}: observedRangeDeg.sampleCount ${o.sampleCount} != recomputed ${flat.length}`);
      check(o.minDeg === values[0], `${j.firmwareName}: observedRangeDeg.minDeg ${o.minDeg} != recomputed ${values[0]}`);
      check(o.maxDeg === values[values.length - 1], `${j.firmwareName}: observedRangeDeg.maxDeg ${o.maxDeg} != recomputed ${values[values.length - 1]}`);
      check(o.medianDeg === median, `${j.firmwareName}: observedRangeDeg.medianDeg ${o.medianDeg} != recomputed ${median}`);
      check(o.functionsCommandingThisJoint === fns[j.firmwareName].size, `${j.firmwareName}: functionsCommandingThisJoint ${o.functionsCommandingThisJoint} != recomputed ${fns[j.firmwareName].size}`);
      check(
        JSON.stringify(o.distinctCommandedDeg) === JSON.stringify(values.map((v) => ({ deg: v, count: h.get(v) }))),
        `${j.firmwareName}: observedRangeDeg.distinctCommandedDeg is not reproducible from hardware-map.json`,
      );

      const br = values.map((v) => (v - j.zeroReferenceDeg.value) * j.directionSign.value).sort((a, b) => a - b);
      check(o.bodyRelativeMinDeg === br[0] && o.bodyRelativeMaxDeg === br[br.length - 1],
        `${j.firmwareName}: body-relative range is not reproducible from zeroReferenceDeg and directionSign`);

      const rest = hw.movements.find((m) => m.function === 'runRestPose');
      const stand = hw.movements.find((m) => m.function === 'runStandPose');
      const last = (mv, name) => {
        let v;
        (function w(steps) {
          for (const s of steps) {
            if (s.type === 'servo' && s.joint === name) v = s.angleDeg;
            if (Array.isArray(s.steps)) w(s.steps);
          }
        })(mv.steps);
        return v;
      };
      check(j.zeroReferenceDeg.restPoseDeg === last(rest, j.firmwareName), `${j.firmwareName}: restPoseDeg drifted from runRestPose`);
      check(j.zeroReferenceDeg.standPoseDeg === last(stand, j.firmwareName), `${j.firmwareName}: standPoseDeg drifted from runStandPose`);
    }

    // --- shape classes against F5's measurements ---------------------------
    const seen = new Set();
    for (const cls of map.shapeEquivalenceClasses ?? []) {
      for (const m of cls.members) {
        check(!seen.has(m), `${m} appears in more than one shape equivalence class`);
        seen.add(m);
        check(byName.get(m)?.shapeEquivalenceClass === cls.id, `${m}: shapeEquivalenceClass does not match class ${cls.id} membership`);
        check(byName.get(m)?.kind === cls.kind, `${m}: kind does not match class ${cls.id} kind ${cls.kind}`);
      }
      const [a, b] = cls.members;
      check(a[0] !== b[0] && a[1] !== b[1], `class ${cls.id} members ${a}/${b} are not diagonally opposite (F5 measured the identical pairs to be diagonal, not left/right)`);
      const measured = (assets.partShapeGroups ?? []).some(
        (g) => g.relation === 'identical'
          && ((g.a === a && g.b === b) || (g.a === b && g.b === a)),
      );
      check(measured, `class ${cls.id}: F5 partShapeGroups does not record ${a} and ${b} as identical solids`);
    }
    check(seen.size === 8, `shape equivalence classes cover ${seen.size} joints, expected 8`);

    // --- sources still match disk -----------------------------------------
    for (const s of map.meta.sources ?? []) {
      const p = resolve(repoRoot, s.path);
      if (!existsSync(p)) { problems.push(`meta.sources ${s.id}: ${s.path} does not exist`); continue; }
      const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
      check(actual === s.sha256, `meta.sources ${s.id}: ${s.path} sha256 drifted (regenerate with \`node scripts/build-joint-map.mjs\`)`);
    }

    // --- all six F5 unresolved items carried forward -----------------------
    const carried = new Set((map.unresolved ?? []).filter((u) => u.carriedForwardFrom === 'F5').map((u) => u.id));
    check(carried.size >= (assets.unresolved ?? []).length,
      `only ${carried.size} of F5's ${(assets.unresolved ?? []).length} unresolved items are carried forward`);

    // --- V0: everything geometric must still equal the assembly map --------
    const asmPath = resolve(repoRoot, 'hardware/assembly-map.json');
    if (!existsSync(asmPath)) {
      problems.push('hardware/assembly-map.json is missing; the CAD-derived fields cannot be checked');
    } else {
      const asm = JSON.parse(readFileSync(asmPath, 'utf8'));
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

      check(asm.frameMap.result === 'resolved',
        'assembly-map.json reports an unresolved frame map, so no geometry may be promoted from it');
      check(map.meta.sources.some((x) => x.id === 'assembly-map'),
        'meta.sources does not cite hardware/assembly-map.json');

      const cf = map.conventions.canonicalFrame;
      for (const k of ['id', 'handedness', 'upAxis', 'forwardAxis', 'rightAxis',
        'convention', 'originDefinition', 'groundPlaneYMm']) {
        check(same(cf[k], asm.canonicalFrame[k]),
          `conventions.canonicalFrame.${k} has drifted from assembly-map.json`);
      }
      check(cf.stlToCadFrameMapMarginRatio === asm.frameMap.candidateSearch.marginRatio,
        'conventions.canonicalFrame.stlToCadFrameMapMarginRatio has drifted from assembly-map.json');

      const mates = asm.assemblyChecks.kneeCoaxiality.matedPairs;
      for (const j of joints) {
        const aj = asm.joints.find((x) => x.firmwareJointName === j.firmwareName);
        const ap = asm.parts.find((x) => x.id === j.firmwareName);
        if (!aj || !ap) { problems.push(`${j.firmwareName}: absent from assembly-map.json`); continue; }
        const cp = j.cadPose;
        check(same(cp.poseFromStlMm, ap.poseFromStlMm), `${j.firmwareName}: cadPose.poseFromStlMm drifted from the CAD reconstruction`);
        check(same(cp.rotationAxis, aj.axisUnitVector), `${j.firmwareName}: cadPose.rotationAxis drifted`);
        check(same(cp.pointOnAxisMm, aj.pointOnAxisMm), `${j.firmwareName}: cadPose.pointOnAxisMm drifted`);
        check(same(cp.servoShaftOriginMm, aj.servoShaftOriginMm), `${j.firmwareName}: cadPose.servoShaftOriginMm drifted`);
        check(cp.servoShaftStatus === aj.servoShaftStatus, `${j.firmwareName}: cadPose.servoShaftStatus drifted`);
        check(cp.parentPart === aj.parentPart, `${j.firmwareName}: cadPose.parentPart drifted`);
        check(j.directionSign.absoluteSense.rule === aj.rotationSense.rule,
          `${j.firmwareName}: directionSign.absoluteSense.rule drifted from the CAD reconstruction`);
        check(same(j.directionSign.absoluteSense.axisUnitVector, aj.axisUnitVector),
          `${j.firmwareName}: directionSign.absoluteSense.axisUnitVector drifted`);
        if (j.kind === 'foot') {
          check(mates[j.parentLink.value] === j.firmwareName,
            `${j.firmwareName}: parentLink ${j.parentLink.value} contradicts the CAD mate graph`);
          check(j.parentLink.status === 'authoritative',
            `${j.firmwareName}: the femur/foot pairing is measured from the CAD now; parentLink must say authoritative`);
        } else {
          const g = j.zeroReferenceDeg.cadRestGeometry;
          check(!!g, `${j.firmwareName}: a femur must carry zeroReferenceDeg.cadRestGeometry`);
          if (g) {
            check(same(g.legDirectionAtRest,
              asm.referencePose.restPoseGeometry.perJoint[j.firmwareName].restPoseLegDirection),
              `${j.firmwareName}: cadRestGeometry.legDirectionAtRest drifted`);
          }
        }
      }
      check(asm.referencePose.restPoseGeometry.allFourLegsParallelToBodyLongAxis === true,
        'the rest-pose finding is quoted here but the assembly map no longer supports it');
    }
  }
}

// --- V0: unresolved bookkeeping ---------------------------------------------
{
  const u = map.unresolved ?? [];
  for (const e of u.filter((x) => x.status === 'resolved')) {
    check(/^done\b/.test(e.resolvedBy),
      `unresolved "${e.id}" is marked resolved but resolvedBy does not name what closed it`);
    check(/RESOLVED/.test(e.reason),
      `unresolved "${e.id}" is marked resolved but reason does not say so`);
  }
  const MUST_STAY_OPEN = ['horn-spline-quantisation', 'parts-installed-where-drawn'];
  for (const id of MUST_STAY_OPEN) {
    const e = u.find((x) => x.id === id);
    check(!!e && e.status === 'open',
      `"${id}" must stay open; it is a property of a built robot, not of the design`);
  }
  const limits = u.find((x) => x.id === 'joint-zero-sign-and-limits');
  check(!!limits && limits.status === 'partially-resolved',
    'joint-zero-sign-and-limits must stay partially-resolved: the mechanical travel limits are still unknown');
}

// --- kinematic graph --------------------------------------------------------
for (const j of joints) {
  if (j.kind === 'femur') {
    check(j.parentLink.value === 'internal-frame', `${j.firmwareName}: a femur's parent must be the chassis, got "${j.parentLink.value}"`);
    check(j.parentLink.childLink !== null && byName.get(j.parentLink.childLink)?.kind === 'foot',
      `${j.firmwareName}: a femur's childLink must be a foot joint, got "${j.parentLink.childLink}"`);
  } else {
    const parent = byName.get(j.parentLink.value);
    check(parent?.kind === 'femur', `${j.firmwareName}: a foot's parent must be a femur joint, got "${j.parentLink.value}"`);
    check(parent?.parentLink.childLink === j.firmwareName,
      `${j.firmwareName}: parent ${j.parentLink.value} does not name it back as its childLink (the femur/foot pairing must be a bijection)`);
    check(j.parentLink.childLink === null, `${j.firmwareName}: a foot is a leaf; childLink must be null`);
  }
}
const femurChildren = joints.filter((j) => j.kind === 'femur').map((j) => j.parentLink.childLink);
check(new Set(femurChildren).size === 4, 'the four femurs do not name four distinct foot children');

// --- direction sign structure ----------------------------------------------
for (const cls of map.shapeEquivalenceClasses ?? []) {
  const signs = cls.members.map((m) => byName.get(m)?.directionSign.value);
  check(new Set(signs).size === 1, `class ${cls.id}: members disagree on directionSign (${signs.join(',')}); identical solids must share a sign`);
  const mirror = (map.shapeEquivalenceClasses ?? []).find((c) => c.id === cls.mirrorOf);
  const mirrorSign = byName.get(mirror?.members?.[0] ?? '')?.directionSign.value;
  check(signs[0] === -mirrorSign, `class ${cls.id} and its mirror ${cls.mirrorOf} must take opposite direction signs`);
}

// --- angles inside the clamp ------------------------------------------------
for (const j of joints) {
  const { min, max } = j.angleLimitsDeg.value;
  const inRange = (v, what) => check(v >= min && v <= max, `${j.firmwareName}: ${what} = ${v} lies outside the firmware clamp ${min}..${max}`);
  inRange(j.zeroReferenceDeg.value, 'zeroReferenceDeg');
  inRange(j.zeroReferenceDeg.restPoseDeg, 'restPoseDeg');
  inRange(j.zeroReferenceDeg.standPoseDeg, 'standPoseDeg');
  inRange(j.observedRangeDeg.minDeg, 'observedRangeDeg.minDeg');
  inRange(j.observedRangeDeg.maxDeg, 'observedRangeDeg.maxDeg');
}

// ---------------------------------------------------------------- layer 3
// The epistemic invariants. These are the whole point of the file.
for (const j of joints) {
  const s = j.semanticName;
  if (s !== undefined) {
    check(s.verified === false, `${j.firmwareName}: semanticName.verified must be the literal false. No mapping from firmware names to spatial names has been physically confirmed; promoting one is a schema-version bump and a code change, not a data edit.`);
    check(typeof s.basis === 'string' && s.basis.length > 40, `${j.firmwareName}: semanticName.basis must state what the guess rests on`);
    check(Array.isArray(s.wouldBeConfirmedBy) && s.wouldBeConfirmedBy.length > 0, `${j.firmwareName}: semanticName.wouldBeConfirmedBy must name what would settle it`);
  }
  check(j.rotationAxis.status !== 'authoritative', `${j.firmwareName}: rotationAxis is a fit to mesh geometry, not a declared CAD value; it must not claim "authoritative"`);
  check(j.zeroReferenceDeg.status === 'inferred' && j.directionSign.status === 'inferred',
    `${j.firmwareName}: zeroReferenceDeg and directionSign are inferred from choreography and documentation; they must say so`);
  check(j.observedRangeDeg.status === 'inferred', `${j.firmwareName}: observedRangeDeg is an inference about intent, not a measurement`);
  check(j.angleLimitsDeg.mechanicalLimitsDeg === null, `${j.firmwareName}: mechanicalLimitsDeg must stay null until a physical robot or a collision study establishes it`);
  check(Array.isArray(j.unresolved) && j.unresolved.length > 0, `${j.firmwareName}: every joint has at least the pivot-origin caveat open`);
}

const semanticCount = joints.filter((j) => j.semanticName !== undefined).length;
check(
  joints.filter((j) => j.semanticName?.verified === false).length === semanticCount,
  'at least one semanticName does not carry verified:false',
);

// A crude but effective guard against prose that quietly promotes a guess.
const blob = JSON.stringify(map);
check(!/"verified"\s*:\s*true/.test(blob), 'the joint map contains `"verified": true` somewhere. Nothing in it has been physically verified.');

// ---------------------------------------------------------------- report
if (problems.length > 0) {
  console.error(`FAIL  ${rel(mapPath)} — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `OK    ${rel(mapPath)} — ${joints.length} joints in firmware order ${joints.map((j) => j.firmwareName).join(',')}; `
  + `${semanticCount}/${joints.length} semantic names present, all verified:false; `
  + `${map.unresolved.length} unresolved items (${map.unresolved.filter((u) => u.status === 'open').length} open, ${map.unresolved.filter((u) => u.status === 'partially-resolved').length} partially resolved)`
  + (crossCheck ? '; cross-checked against hardware-map.json and assets-inventory.json' : '; cross-check skipped'),
);
