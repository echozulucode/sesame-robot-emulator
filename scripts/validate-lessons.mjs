#!/usr/bin/env node
/**
 * Validates hardware/lessons.json (L5).
 *
 * Six layers. Nothing is trusted from the generator: every derived value is
 * recomputed here from the same primary sources, so a bug in build-lessons.mjs
 * that produces plausible output still fails.
 *
 *  1. JSON Schema (draft 2020-12, ajv, strict, additionalProperties:false
 *     throughout). A typo'd key is a hard failure.
 *
 *  2. Internal integrity: ids unique, orders dense and monotonic, prerequisites
 *     resolve and point strictly backwards, `unlocks` really is the inverse of
 *     `prerequisites`, challenge unlock targets exist, and every lesson's link
 *     unions equal the union of its steps' links.
 *
 *  3. Cross-artifact resolution. EVERY reference is resolved against the
 *     artifact that owns it:
 *       - symbolRef  -> hardware/source-annotations.json symbols[], and the
 *                       cited file/startLine/endLine must MATCH that symbol
 *       - conceptRef -> source-annotations.json concepts[]
 *       - TN ref     -> source-annotations.json teachingNotes[], title compared
 *       - robotParts -> JOINT_ORDER, read out of packages/sesame-model/src/joints.ts
 *       - traceLayer -> TRACE_LAYERS in apps/web (warned + skipped if absent)
 *       - hardware-map path -> resolved into hardware/hardware-map.json
 *       - movement / face / route / boot-order / command referenced by a success
 *         check -> the corresponding hardware-map entity
 *       - document citation -> the file exists
 *       - issue citation    -> the id appears in docs/issues.yaml
 *       - library citation  -> the version matches reproducibility.json
 *
 *  4. GATE F. The rule this artifact exists to keep:
 *       - a claim with type "factual" and domain "firmware" MUST carry at least
 *         one symbol citation that resolves. No exceptions, no waivers.
 *       - domain "library" / "emulator" / "lab" must carry their own kind of
 *         citation AND a boundaryNote; "emulator" must also state observability.
 *       - a claim with type "conceptual" must carry a conceptualReason and may
 *         not use "actually works" framing.
 *       - lesson.grounding, groundingNote and conceptualReason must EQUAL
 *         source-annotations.json curriculum[curriculumRef]. A lesson cannot
 *         promote itself from conceptual to factual.
 *       - every conceptual lesson must contain at least one step that discloses
 *         its boundary (a conceptual claim with groundingDisclosure).
 *
 *  5. Anti-pattern screens, from the research report's explicit list: no
 *     hardware claims, no mascot narration, no fake currency, no confetti,
 *     no timer-based unlocks, short beginner12 copy, cause-and-effect coverage
 *     on polished steps, and failureIsNormal on every debug step.
 *
 *  6. Recomputation: the PWM/quantisation numbers, the pose vectors, the direct
 *     joint lists and the whole coverage block are recomputed and compared.
 *
 * Usage:
 *   node scripts/validate-lessons.mjs [lessons.json] [schema.json]
 * Exit 0 = valid, 1 = invalid.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const docPath = resolve(repoRoot, positional[0] ?? 'hardware/lessons.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/lessons.schema.json');

function fail(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }
function readJson(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (err) { fail(`cannot read ${rel(path)}: ${err.message}`); }
  try { return JSON.parse(raw); } catch (err) { fail(`${rel(path)} is not valid JSON: ${err.message}`); }
  return null;
}

const problems = [];
const warnings = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

const schema = readJson(schemaPath);
const doc = readJson(docPath);
const SA = readJson(resolve(repoRoot, 'hardware/source-annotations.json'));
const HW = readJson(resolve(repoRoot, 'hardware/hardware-map.json'));
const REPRO = readJson(resolve(repoRoot, 'reproducibility.json'));

// ------------------------------------------------------------------ layer 1
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
let validate;
try { validate = ajv.compile(schema); } catch (err) { fail(`schema ${rel(schemaPath)} did not compile: ${err.message}`); }
if (!validate(doc)) {
  console.error(`FAIL  ${rel(docPath)} does not validate against ${rel(schemaPath)}:`);
  for (const e of validate.errors ?? []) {
    const at = e.instancePath || '(root)';
    const extra = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
    console.error(`  - ${at} ${e.message}${extra}`);
  }
  process.exit(1);
}

// ------------------------------------------------------------ shared indexes
const SYM = new Map(SA.symbols.map((s) => [s.id, s]));
const CONCEPT = new Set(SA.concepts.map((c) => c.id));
const NOTE = new Map(SA.teachingNotes.map((n) => [n.id, n]));
const MODULE = new Map(SA.curriculum.map((m) => [m.id, m]));
const MOVEMENT = new Map(HW.movements.map((m) => [m.function, m]));
const FACE = new Set(HW.faces.faces.map((f) => f.name));
const ROUTE = new Set(HW.network.http.routes.map((r) => r.path));
const BOOT = new Set(HW.bootOrder.map((b) => b.order));
const SERIAL = new Set(HW.commands.serialCli.flatMap((c) => String(c.input).split(',').map((s) => s.trim())));
const BOARD = new Set(HW.boards.map((b) => b.id));
const lessons = doc.lessons;
const allSteps = lessons.flatMap((l) => l.steps);
const allSuccess = [...allSteps.map((s) => s.success), ...lessons.flatMap((l) => l.challenges.map((c) => c.success))].filter(Boolean);

/** JOINT_ORDER, read out of the package that owns it. */
const JOINT_ORDER = (() => {
  const p = resolve(repoRoot, 'packages/sesame-model/src/joints.ts');
  if (!existsSync(p)) { warnings.push('packages/sesame-model/src/joints.ts absent; JOINT_ORDER checked against hardware-map servos.order only'); return HW.servos.order.slice(); }
  const m = readFileSync(p, 'utf8').match(/export const JOINT_ORDER = \[([^\]]+)\] as const;/);
  if (!m) { problems.push('could not parse JOINT_ORDER out of packages/sesame-model/src/joints.ts'); return HW.servos.order.slice(); }
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();
check(JOINT_ORDER.join(',') === HW.servos.order.join(','), `JOINT_ORDER (${JOINT_ORDER.join(',')}) disagrees with hardware-map servos.order (${HW.servos.order.join(',')})`);

/** The eight trace layers, from the app that owns them. Warned + skipped if the file has moved. */
const APP_TRACE_LAYERS = (() => {
  const p = resolve(repoRoot, 'apps/web/src/state/trace-store.ts');
  if (!existsSync(p)) { warnings.push('apps/web/src/state/trace-store.ts absent; trace layer ids not cross-checked against the app'); return null; }
  const m = readFileSync(p, 'utf8').match(/export const TRACE_LAYERS = \[([\s\S]*?)\] as const;/);
  if (!m) { warnings.push('could not parse TRACE_LAYERS out of apps/web/src/state/trace-store.ts'); return null; }
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();
const declaredLayers = doc.vocabularies.traceLayers.map((l) => l.id);
if (APP_TRACE_LAYERS) {
  check(APP_TRACE_LAYERS.join(',') === declaredLayers.join(','), `vocabularies.traceLayers (${declaredLayers.join(',')}) disagrees with the app's TRACE_LAYERS (${APP_TRACE_LAYERS.join(',')})`);
}

const ISSUES_TEXT = existsSync(resolve(repoRoot, 'docs/issues.yaml')) ? readFileSync(resolve(repoRoot, 'docs/issues.yaml'), 'utf8') : null;
if (!ISSUES_TEXT) warnings.push('docs/issues.yaml absent; issue citations not resolved');

function resolveHwPath(path) {
  let cur = HW;
  for (const raw of path.split('.')) {
    const m = raw.match(/^([^[\]]+)((\[[^\]]+\])*)$/);
    if (!m) return { ok: false, why: `malformed at "${raw}"` };
    const key = m[1];
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return { ok: false, why: `no "${key}"` };
    cur = cur[key];
    for (const sel of (m[2] ?? '').matchAll(/\[([^\]]+)\]/g)) {
      const inner = sel[1];
      if (!Array.isArray(cur)) return { ok: false, why: `[${inner}] applied to a non-array` };
      if (/^\d+$/.test(inner)) cur = cur[Number(inner)];
      else {
        const eq = inner.indexOf('=');
        if (eq < 0) return { ok: false, why: `selector "[${inner}]" is neither an index nor field=value` };
        cur = cur.find((el) => el && String(el[inner.slice(0, eq)]) === inner.slice(eq + 1));
      }
      if (cur === undefined) return { ok: false, why: `selector "[${inner}]" matched nothing` };
    }
  }
  return { ok: true, value: cur };
}

// ------------------------------------------------------------------ layer 2
{
  const lessonIds = new Set();
  for (const [i, l] of lessons.entries()) {
    check(!lessonIds.has(l.id), `duplicate lesson id "${l.id}"`);
    lessonIds.add(l.id);
    check(l.order === i + 1, `lesson "${l.id}" has order ${l.order} at position ${i + 1}`);
  }
  const orderOf = new Map(lessons.map((l) => [l.id, l.order]));
  const successIds = new Set();
  for (const l of lessons) {
    for (const p of l.prerequisites) {
      check(orderOf.has(p), `lesson "${l.id}" requires "${p}", which is not a lesson`);
      if (orderOf.has(p)) check(orderOf.get(p) < l.order, `lesson "${l.id}" (order ${l.order}) requires "${p}" (order ${orderOf.get(p)}), which comes later — prerequisites must point backwards`);
    }
    const expectedUnlocks = lessons.filter((o) => o.prerequisites.includes(l.id)).map((o) => o.id);
    check(JSON.stringify(l.unlocks) === JSON.stringify(expectedUnlocks), `lesson "${l.id}" unlocks ${JSON.stringify(l.unlocks)} but the inverse of prerequisites is ${JSON.stringify(expectedUnlocks)}`);

    const stepIds = new Set();
    for (const [i, s] of l.steps.entries()) {
      check(!stepIds.has(s.id), `lesson "${l.id}" has duplicate step id "${s.id}"`);
      stepIds.add(s.id);
      check(s.order === i + 1, `step "${l.id}/${s.id}" has order ${s.order} at position ${i + 1}`);
      if (s.success) {
        check(!successIds.has(s.success.id), `duplicate success id "${s.success.id}"`);
        successIds.add(s.success.id);
      }
    }
    for (const c of l.challenges) {
      check(l.steps.some((s) => s.success?.id === c.unlockedBy), `challenge "${c.id}" is unlocked by "${c.unlockedBy}", which is not a success condition in lesson "${l.id}"`);
      check(!successIds.has(c.success.id), `duplicate success id "${c.success.id}"`);
      successIds.add(c.success.id);
    }

    // Lesson link unions must equal the union of their steps'.
    for (const field of ['symbols', 'concepts', 'teachingNotes', 'hardwareMap']) {
      const expected = [...new Set(l.steps.flatMap((s) => s.links[field]))].sort();
      check(JSON.stringify(l.links[field]) === JSON.stringify(expected), `lesson "${l.id}" links.${field} is not the sorted union of its steps' (${JSON.stringify(l.links[field])} vs ${JSON.stringify(expected)})`);
    }
    const expectedJoints = JOINT_ORDER.filter((j) => l.steps.some((s) => s.links.robotParts.includes(j)));
    check(JSON.stringify(l.links.robotParts) === JSON.stringify(expectedJoints), `lesson "${l.id}" links.robotParts is not the JOINT_ORDER-ordered union of its steps' (${JSON.stringify(l.links.robotParts)} vs ${JSON.stringify(expectedJoints)})`);
    const expectedLayers = declaredLayers.filter((t) => l.steps.some((s) => s.links.traceLayers.includes(t)));
    check(JSON.stringify(l.links.traceLayers) === JSON.stringify(expectedLayers), `lesson "${l.id}" links.traceLayers is not the causal-order union of its steps'`);
  }
}

// ------------------------------------------------------------------ layer 3
const CHECK_TYPE = new Map(doc.vocabularies.checkTypes.map((c) => [c.id, c]));
const CONTROL = new Set(doc.vocabularies.controlKinds.map((c) => c.id));
const FAULT = new Map(doc.vocabularies.faults.map((f) => [f.id, f]));
const OBSERVABILITY = new Set(doc.vocabularies.observability.map((o) => o.id));

function checkCitation(where, c) {
  switch (c.kind) {
    case 'symbol': {
      const s = SYM.get(c.symbol);
      if (!s) { problems.push(`${where}: symbolRef "${c.symbol}" does not resolve in source-annotations.json`); return; }
      check(c.file === s.file, `${where}: symbolRef "${c.symbol}" cites file ${c.file}, but the annotation says ${s.file}`);
      check(c.startLine === s.startLine, `${where}: symbolRef "${c.symbol}" cites startLine ${c.startLine}, but the annotation says ${s.startLine}`);
      check(c.endLine === s.endLine, `${where}: symbolRef "${c.symbol}" cites endLine ${c.endLine}, but the annotation says ${s.endLine}`);
      check((c.signature ?? null) === (s.signature ?? null), `${where}: symbolRef "${c.symbol}" signature does not match the annotation`);
      break;
    }
    case 'hardware-map': {
      const r = resolveHwPath(c.path);
      check(r.ok, `${where}: hardware-map path "${c.path}" does not resolve (${r.why ?? ''})`);
      break;
    }
    case 'library': {
      const pinned = REPRO.libraries?.[c.library];
      check(!!pinned, `${where}: library "${c.library}" is not pinned in reproducibility.json`);
      if (pinned) check(pinned === c.version, `${where}: library "${c.library}" cited at ${c.version}, pinned at ${pinned}`);
      break;
    }
    case 'document':
      check(existsSync(resolve(repoRoot, c.doc)), `${where}: document citation "${c.doc}" does not exist`);
      break;
    case 'issue':
      if (ISSUES_TEXT) check(ISSUES_TEXT.includes(c.id), `${where}: issue "${c.id}" does not appear in docs/issues.yaml`);
      break;
    case 'teaching-note': {
      const n = NOTE.get(c.note);
      if (!n) { problems.push(`${where}: teaching note "${c.note}" does not resolve in source-annotations.json`); return; }
      check(n.title === c.title, `${where}: teaching note "${c.note}" title has drifted from source-annotations.json`);
      break;
    }
    default:
      problems.push(`${where}: unknown citation kind "${c.kind}"`);
  }
}

function checkSuccess(where, s) {
  const t = CHECK_TYPE.get(s.check.type);
  if (!t) { problems.push(`${where}: success "${s.id}" uses undeclared check type "${s.check.type}"`); return; }
  for (const r of t.requires) check(r in s.check, `${where}: success "${s.id}" (${s.check.type}) is missing required parameter "${r}"`);
  const c = s.check;
  for (const [key, val] of Object.entries(c)) {
    switch (key) {
      case 'movement': case 'basedOnMovement': case 'duringMovement':
        check(MOVEMENT.has(val), `${where}: success "${s.id}" names movement "${val}", which is not in hardware-map.json`); break;
      case 'faceName': case 'requestedFace': case 'expectFace':
        check(FACE.has(val) || val === 'default', `${where}: success "${s.id}" names face "${val}", which is not in the face registry`); break;
      case 'route':
        check(ROUTE.has(val), `${where}: success "${s.id}" names route "${val}", which is not in the route table`); break;
      case 'expectBootOrder': case 'expectBootOrderReached': case 'expectHaltAtBootOrder':
        check(BOOT.has(val), `${where}: success "${s.id}" names bootOrder ${val}, which is not a boot step`); break;
      case 'input':
        check(SERIAL.has(val), `${where}: success "${s.id}" sends serial input "${val}", which is not in commands.serialCli`); break;
      case 'fromBoard': case 'toBoard':
        check(BOARD.has(val), `${where}: success "${s.id}" names board "${val}", which is not in hardware-map boards[]`); break;
      case 'faultId':
        check(FAULT.has(val), `${where}: success "${s.id}" names fault "${val}", which is not declared in vocabularies.faults`); break;
      case 'symbol': case 'expectIdentifiedSymbol':
        check(SYM.has(val), `${where}: success "${s.id}" names symbol "${val}", which does not resolve in source-annotations.json`); break;
      case 'joint':
        check(JOINT_ORDER.includes(val), `${where}: success "${s.id}" names joint "${val}", which is not in JOINT_ORDER`); break;
      case 'joints': case 'expectDirectJoints':
        for (const j of val) check(JOINT_ORDER.includes(j), `${where}: success "${s.id}" names joint "${j}", which is not in JOINT_ORDER`);
        break;
      case 'traceLayer':
        check(declaredLayers.includes(val), `${where}: success "${s.id}" names trace layer "${val}", which is not declared`); break;
      case 'traceLayers':
        for (const t2 of val) check(declaredLayers.includes(t2), `${where}: success "${s.id}" names trace layer "${t2}", which is not declared`);
        break;
      case 'expectMode':
        check(['once', 'loop', 'boomerang'].includes(val), `${where}: success "${s.id}" names face mode "${val}"`); break;
      case 'expect':
        for (const e of val) check(JOINT_ORDER.includes(e.joint), `${where}: success "${s.id}" pose vector names joint "${e.joint}"`);
        break;
      default: break;
    }
  }
}

for (const l of lessons) {
  for (const s of l.steps) {
    const where = `${l.id}/${s.id}`;
    for (const c of s.claim.citations) checkCitation(where, c);
    for (const c of s.goDeeper?.citations ?? []) checkCitation(`${where} (goDeeper)`, c);
    for (const id of s.links.symbols) check(SYM.has(id), `${where}: links.symbols "${id}" does not resolve in source-annotations.json`);
    for (const id of s.links.concepts) check(CONCEPT.has(id), `${where}: conceptRef "${id}" does not resolve in source-annotations.json`);
    for (const id of s.links.teachingNotes) check(NOTE.has(id), `${where}: teaching note "${id}" does not resolve in source-annotations.json`);
    for (const j of s.links.robotParts) check(JOINT_ORDER.includes(j), `${where}: robotParts "${j}" is not in JOINT_ORDER`);
    for (const t of s.links.traceLayers) check(declaredLayers.includes(t), `${where}: traceLayer "${t}" is not declared`);
    for (const p of s.links.hardwareMap) check(resolveHwPath(p).ok, `${where}: links.hardwareMap "${p}" does not resolve`);
    // links.symbols must be exactly the symbols cited by this step.
    const cited = [...new Set([...s.claim.citations, ...(s.goDeeper?.citations ?? [])].filter((c) => c.kind === 'symbol').map((c) => c.symbol))];
    check(JSON.stringify([...s.links.symbols].sort()) === JSON.stringify([...cited].sort()), `${where}: links.symbols does not match the symbols actually cited by the step`);
    if (s.manipulate) check(CONTROL.has(s.manipulate.control), `${where}: manipulate.control "${s.manipulate.control}" is not a declared control kind`);
    if (s.success) checkSuccess(where, s.success);
  }
  for (const c of l.challenges) {
    check(CONCEPT.has(c.coreConcept), `${l.id}/${c.id}: coreConcept "${c.coreConcept}" does not resolve`);
    checkSuccess(`${l.id}/${c.id}`, c.success);
  }
}
for (const f of doc.vocabularies.faults) {
  check(SYM.has(f.causeSymbol), `fault "${f.id}" names causeSymbol "${f.causeSymbol}", which does not resolve`);
  check(NOTE.has(f.teachingNote), `fault "${f.id}" names teaching note "${f.teachingNote}", which does not resolve`);
}
check(doc.meta.upstreamCommit === SA.meta.upstreamCommit, `meta.upstreamCommit does not match source-annotations.json`);

// ------------------------------------------------------------------ layer 4
// GATE F.
const ACTUALLY_WORKS = /\b(actually|really)\s+works\b|\bhow sesame (actually|really)\b|\bin reality the robot\b/i;
for (const l of lessons) {
  const mod = MODULE.get(l.curriculumRef);
  if (!mod) { problems.push(`lesson "${l.id}" curriculumRef "${l.curriculumRef}" is not a module in source-annotations.json`); continue; }
  check(l.grounding === mod.grounding, `GATE F: lesson "${l.id}" claims grounding "${l.grounding}" but source-annotations.json says "${mod.grounding}" — a lesson cannot re-decide its own grounding`);
  check((l.groundingNote ?? null) === (mod.groundingNote ?? null), `lesson "${l.id}" groundingNote has drifted from source-annotations.json`);
  check((l.conceptualReason ?? null) === (mod.conceptualReason ?? null), `lesson "${l.id}" conceptualReason has drifted from source-annotations.json`);
  check(l.module === mod.module && l.mainExperience === mod.mainExperience && l.realSesameConcept === mod.realSesameConcept, `lesson "${l.id}" module/mainExperience/realSesameConcept have drifted from source-annotations.json`);

  if (l.grounding === 'conceptual') {
    check(!!l.conceptualReason, `GATE F: conceptual lesson "${l.id}" has no conceptualReason`);
    check(l.steps.some((s) => s.claim.type === 'conceptual' && s.claim.groundingDisclosure), `GATE F: conceptual lesson "${l.id}" never discloses its boundary — it needs at least one step with a conceptual claim carrying groundingDisclosure`);
  }

  for (const s of l.steps) {
    const where = `${l.id}/${s.id}`;
    const c = s.claim;
    if (c.type === 'factual') {
      check(c.domain !== 'none', `GATE F: ${where} is a factual claim with domain "none"`);
      check(c.citations.length > 0, `GATE F: ${where} is a factual claim with no citations`);
      if (c.domain === 'firmware') {
        const syms = c.citations.filter((x) => x.kind === 'symbol');
        check(syms.length > 0, `GATE F: ${where} asserts a FIRMWARE fact with no symbolRef. Cite a pinned symbol, or type the claim as conceptual.`);
        for (const sc of syms) check(SYM.has(sc.symbol), `GATE F: ${where} cites symbol "${sc.symbol}", which does not resolve`);
        check(!c.boundaryNote, `${where}: a firmware claim should not carry a boundaryNote — it has no boundary to declare`);
      }
      if (c.domain === 'library') {
        check(c.citations.some((x) => x.kind === 'library'), `GATE F: ${where} asserts a LIBRARY fact with no library citation`);
        check(!!c.boundaryNote, `GATE F: ${where} asserts a library fact without a boundaryNote saying it is not Sesame source`);
      }
      if (c.domain === 'emulator') {
        check(c.citations.some((x) => x.kind === 'document'), `GATE F: ${where} asserts an EMULATOR fact with no document citation`);
        check(!!c.boundaryNote, `GATE F: ${where} asserts an emulator fact without a boundaryNote`);
        check(!!c.observability && OBSERVABILITY.has(c.observability), `GATE F: ${where} asserts an emulator fact without a declared observability value`);
      }
      if (c.domain === 'lab') {
        check(c.citations.some((x) => x.kind === 'document' || x.kind === 'hardware-map' || x.kind === 'symbol'), `GATE F: ${where} asserts a LAB fact with no citation`);
        check(!!c.boundaryNote, `GATE F: ${where} asserts a lab fact without a boundaryNote`);
      }
      if (c.domain !== 'firmware') check(c.groundingDisclosure === true, `GATE F: ${where} is a non-firmware factual claim and must set groundingDisclosure`);
    } else {
      check(c.domain === 'none', `${where}: a conceptual claim must have domain "none"`);
      check(!!c.conceptualReason, `GATE F: ${where} is a conceptual claim with no conceptualReason`);
      check(c.groundingDisclosure === true, `GATE F: ${where} is a conceptual claim and must set groundingDisclosure`);
      check(!ACTUALLY_WORKS.test(c.text), `GATE F: ${where} is conceptual but uses "this is how Sesame actually works" framing: ${JSON.stringify(c.text.slice(0, 90))}`);
    }
    // No claim of ANY kind may use "actually works" framing without a firmware symbol behind it.
    if (ACTUALLY_WORKS.test(c.text)) {
      check(c.type === 'factual' && c.domain === 'firmware' && c.citations.some((x) => x.kind === 'symbol'), `GATE F: ${where} uses "actually works" framing without a resolving firmware symbolRef`);
    }
  }
}

// ------------------------------------------------------------------ layer 5
// Anti-pattern screens, from the research report's explicit list.
const PROSE_FIELDS = [];
const collectProse = (where, o) => {
  if (typeof o === 'string') PROSE_FIELDS.push([where, o]);
  else if (Array.isArray(o)) o.forEach((v, i) => collectProse(`${where}[${i}]`, v));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) collectProse(`${where}.${k}`, v);
};
for (const l of lessons) collectProse(l.id, { title: l.title, learningGoal: l.learningGoal, willBeAbleTo: l.willBeAbleTo, openQuestions: l.openQuestions, labHandoff: l.labHandoff, steps: l.steps, challenges: l.challenges });

const SCREENS = [
  { id: 'no-hardware-claims', re: /\bservos? (moved|moves|rotated|turned|spun|swept)\b|\bjoints? (moved|moves|rotated|rotates|lifted|lifts)\b|observed at the pin|measured on hardware|\bpulse was (observed|seen|measured)\b|\bwe (measured|probed|scoped)\b|\bthe robot (walked|stood up|waved|danced)\b/i, why: 'no lesson may claim a servo moved or a pulse was seen — only what the code commanded' },
  { id: 'no-mascot', re: /\b(hi there|hey there|sesame says|your friend sesame|little robot friend|buddy|wanna|let's have fun|great job|awesome job|way to go|woohoo|yay)\b/i, why: 'no mascot narration or praise noise' },
  { id: 'no-fake-currency', re: /\b(coins?|gems?|tokens? earned|xp\b|experience points|streaks?|leaderboard|star rating)\b/i, why: 'no fake currency or points' },
  { id: 'no-confetti', re: /\bconfetti\b|\bfireworks\b|\bcelebrat(e|ion)\b/i, why: 'no celebration effects for trivial actions' },
  { id: 'no-timer-gate', re: /\bwait (\d+ )?(seconds|minutes) (to|before you can) (unlock|continue|proceed)\b|\bunlocks? after \d+ (seconds|minutes)\b|\btime(d)? gate\b/i, why: 'challenges unlock by demonstrating a concept, never by a timer' },
  { id: 'no-click-next', re: /\bclick next to (continue|finish|complete)\b|\bpress continue to complete\b/i, why: 'a step is never completed by clicking next' },
];
for (const [where, text] of PROSE_FIELDS) {
  for (const s of SCREENS) if (s.re.test(text)) problems.push(`anti-pattern [${s.id}] at ${where}: ${s.why} — ${JSON.stringify(text.slice(0, 110))}`);
}

// Structural anti-pattern rules.
for (const l of lessons) {
  const full = l.steps.filter((s) => s.detail === 'full');
  if (l.status === 'polished') {
    check(l.steps.every((s) => s.detail === 'full'), `lesson "${l.id}" is polished but has outline steps`);
    check(l.steps.length >= 4, `polished lesson "${l.id}" has only ${l.steps.length} steps`);
  }
  for (const s of l.steps) {
    const where = `${l.id}/${s.id}`;
    check(s.explanation.beginner12.length <= 400, `${where}: beginner12 explanation is ${s.explanation.beginner12.length} chars — short explanations sit next to the control, long ones go in goDeeper`);
    if (s.detail === 'full') {
      check(!!s.explanation.beginnerProgrammer, `${where}: a full step needs all three explanatory levels (beginnerProgrammer missing)`);
      check(!!s.explanation.architecture, `${where}: a full step needs all three explanatory levels (architecture missing)`);
      check(!!s.expect, `${where}: a full step needs a visible cause-and-effect (expect)`);
    }
    check(!!s.success, `${where}: every step needs a checkable success condition`);
    check(!!s.manipulate, `${where}: every step needs something the learner manipulates`);
    if (s.kind === 'debug') check(!!s.success?.failureIsNormal, `${where}: a debug step must frame failure as normal engineering (failureIsNormal is null)`);
  }
  // Depth is optional, never mandatory.
  check(l.steps.filter((s) => s.goDeeper).length < l.steps.length, `lesson "${l.id}": every step carries goDeeper — optional depth must be optional`);
}
// Unlocking is by demonstration: every lesson after the first has a prerequisite,
// and every prerequisite lesson actually has checkable success conditions.
for (const l of lessons.slice(1)) {
  check(l.prerequisites.length > 0, `lesson "${l.id}" has no prerequisite — progression must be earned, not sequential-by-default`);
  for (const p of l.prerequisites) {
    const pre = lessons.find((o) => o.id === p);
    if (pre) check(pre.steps.some((s) => s.success), `lesson "${l.id}" depends on "${p}", which has no success condition to demonstrate`);
  }
}

// ------------------------------------------------------------------ layer 6
// Recomputation: nothing derived is taken on trust.
{
  const pq = HW.servos.servoConfig.pulseQuantisation;
  const minUs = HW.servos.servoConfig.attachMinPulseUs;
  const maxUs = HW.servos.servoConfig.attachMaxPulseUs;
  const usPerTick = pq.frameUs / pq.timerWidthTicks;
  const q = (deg) => {
    const us = Math.trunc((deg * (maxUs - minUs)) / 180) + minUs;
    const ticks = Math.trunc(us / usPerTick);
    return { us, ticks, quantised: Number((ticks * usPerTick).toFixed(5)) };
  };
  const sweep = Array.from({ length: 181 }, (_, d) => q(d));
  const distinct = new Set(sweep.map((x) => x.ticks)).size;
  const aliased = sweep.filter((x, i) => i > 0 && sweep[i - 1].ticks === x.ticks).length;
  const m = doc.vocabularies.pwmModel;
  check(m.distinctPulseValues === distinct, `pwmModel.distinctPulseValues ${m.distinctPulseValues} != recomputed ${distinct}`);
  check(m.aliasedAngles === aliased, `pwmModel.aliasedAngles ${m.aliasedAngles} != recomputed ${aliased}`);
  check(distinct === pq.distinctReachablePulseValues, `recomputed distinct pulse values ${distinct} != hardware-map ${pq.distinctReachablePulseValues}`);
  check(aliased === pq.aliasedAngleCount, `recomputed aliased angles ${aliased} != hardware-map ${pq.aliasedAngleCount}`);
  check(m.usPerTick === usPerTick, `pwmModel.usPerTick ${m.usPerTick} != recomputed ${usPerTick}`);
  const [a, b] = m.aliasPairUsedInLessons;
  check(sweep[a].ticks === sweep[b].ticks, `pwmModel.aliasPairUsedInLessons ${a}/${b} do not actually alias`);

  // Every pwm-value-matched check must carry the recomputed numbers.
  for (const s of allSuccess) {
    if (s.check.type !== 'pwm-value-matched') continue;
    const r = q(s.check.angleDeg);
    check(s.check.expectRequestedPulseUs === r.us, `success "${s.id}": expectRequestedPulseUs ${s.check.expectRequestedPulseUs} != recomputed ${r.us} for ${s.check.angleDeg} deg`);
    check(s.check.expectTicks === r.ticks, `success "${s.id}": expectTicks ${s.check.expectTicks} != recomputed ${r.ticks}`);
    check(s.check.expectQuantisedPulseUs === r.quantised, `success "${s.id}": expectQuantisedPulseUs ${s.check.expectQuantisedPulseUs} != recomputed ${r.quantised}`);
  }
  for (const s of allSuccess) {
    if (s.check.type !== 'quantisation-collision' || s.check.learnerChosen) continue;
    check(q(s.check.angleA).ticks === q(s.check.angleB).ticks, `success "${s.id}": ${s.check.angleA} and ${s.check.angleB} do not alias`);
    if ('expectTicks' in s.check) check(q(s.check.angleA).ticks === s.check.expectTicks, `success "${s.id}": expectTicks does not match the recomputed tick count`);
  }
  for (const s of allSuccess) {
    if (s.check.type !== 'quantisation-survey') continue;
    check(s.check.expectDistinctPulseValues === distinct, `success "${s.id}": expectDistinctPulseValues != recomputed ${distinct}`);
    check(s.check.expectAliasedAngles === aliased, `success "${s.id}": expectAliasedAngles != recomputed ${aliased}`);
  }
}
{
  // Pose vectors and direct-joint lists are recomputed from the owning artifacts.
  const terminalPose = (fn, seen = new Set()) => {
    const mv = MOVEMENT.get(fn);
    if (!mv || seen.has(fn)) return {};
    seen.add(fn);
    const last = {};
    const walk = (steps) => {
      for (const s of steps ?? []) {
        if (s.type === 'servo' && typeof s.angleDeg === 'number') last[s.joint] = s.angleDeg;
        else if (s.type === 'call' && MOVEMENT.has(s.function)) Object.assign(last, terminalPose(s.function, seen));
        else if (Array.isArray(s.steps)) walk(s.steps);
      }
    };
    walk(mv.steps);
    return last;
  };
  for (const s of allSuccess) {
    if (s.check.type === 'pose-vector') {
      const last = terminalPose(s.check.movement);
      const expected = JOINT_ORDER.map((j) => ({ joint: j, angleDeg: last[j] ?? null }));
      check(JSON.stringify(s.check.expect) === JSON.stringify(expected), `success "${s.id}": pose vector for ${s.check.movement} does not match hardware-map choreography\n         got      ${JSON.stringify(s.check.expect)}\n         expected ${JSON.stringify(expected)}`);
    }
    if (s.check.type === 'movement-joints-identified') {
      const symId = Object.keys(Object.fromEntries(SYM)).find((k) => k === s.check.movement);
      const sym = SYM.get(symId ?? s.check.movement);
      if (!sym) problems.push(`success "${s.id}": movement "${s.check.movement}" has no annotated symbol to derive direct joints from`);
      else check(JSON.stringify(s.check.expectDirectJoints) === JSON.stringify(sym.robotParts), `success "${s.id}": expectDirectJoints ${JSON.stringify(s.check.expectDirectJoints)} != source-annotations robotParts ${JSON.stringify(sym.robotParts)}`);
    }
    if (s.check.type === 'face-mode-identified') {
      const mv = MOVEMENT.get(s.check.movement);
      const find = (steps) => { for (const st of steps ?? []) { if (st.type === 'face' && st.mode) return st.mode; if (Array.isArray(st.steps)) { const r = find(st.steps); if (r) return r; } } return null; };
      const mode = mv ? find(mv.steps) : null;
      check(mode === s.check.expectMode, `success "${s.id}": expectMode "${s.check.expectMode}" != hardware-map choreography "${mode}"`);
    }
    if (s.check.type === 'boot-halt') {
      const step = HW.bootOrder.find((b) => b.order === s.check.expectHaltAtBootOrder);
      check(step && step.subsystem === 'display', `success "${s.id}": bootOrder ${s.check.expectHaltAtBootOrder} is not the display step`);
    }
  }
}
{
  // The whole coverage block, recomputed.
  const tally = (arr, key) => Object.fromEntries(Object.entries(arr.reduce((a, v) => { const k = key(v); a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort());
  const claims = allSteps.map((s) => s.claim);
  const usedNotes = new Set(lessons.flatMap((l) => l.links.teachingNotes));
  const usedConcepts = new Set(lessons.flatMap((l) => l.links.concepts));
  const usedSymbols = new Set(lessons.flatMap((l) => l.links.symbols));
  const cov = doc.coverage;
  const eq = (label, got, want) => check(JSON.stringify(got) === JSON.stringify(want), `coverage.${label} is ${JSON.stringify(got)}, recomputed ${JSON.stringify(want)}`);
  eq('lessons.total', cov.lessons.total, lessons.length);
  eq('lessons.polished', cov.lessons.polished, lessons.filter((l) => l.status === 'polished').length);
  eq('lessons.outline', cov.lessons.outline, lessons.filter((l) => l.status === 'outline').length);
  eq('lessons.factual', cov.lessons.factual, lessons.filter((l) => l.grounding === 'factual').length);
  eq('lessons.conceptual', cov.lessons.conceptual, lessons.filter((l) => l.grounding === 'conceptual').length);
  eq('lessons.conceptualLessons', cov.lessons.conceptualLessons, lessons.filter((l) => l.grounding === 'conceptual').map((l) => l.id));
  eq('steps.total', cov.steps.total, allSteps.length);
  eq('steps.byKind', cov.steps.byKind, tally(allSteps, (s) => s.kind));
  eq('steps.withSuccessCondition', cov.steps.withSuccessCondition, allSteps.filter((s) => s.success).length);
  eq('steps.withCauseAndEffect', cov.steps.withCauseAndEffect, allSteps.filter((s) => s.expect).length);
  eq('claims.byType', cov.claims.byType, tally(claims, (c) => c.type));
  eq('claims.byDomain', cov.claims.byDomain, tally(claims, (c) => c.domain));
  eq('claims.firmwareFactualWithSymbolCitation', cov.claims.firmwareFactualWithSymbolCitation, claims.filter((c) => c.type === 'factual' && c.domain === 'firmware' && c.citations.some((x) => x.kind === 'symbol')).length);
  eq('teachingNotes.total', cov.teachingNotes.total, SA.teachingNotes.length);
  eq('teachingNotes.used', cov.teachingNotes.used, usedNotes.size);
  eq('teachingNotes.unused', cov.teachingNotes.unused, SA.teachingNotes.map((n) => n.id).filter((id) => !usedNotes.has(id)));
  eq('concepts.used', cov.concepts.used, usedConcepts.size);
  eq('symbols.cited', cov.symbols.cited, usedSymbols.size);
  eq('robotParts.order', cov.robotParts.order, JOINT_ORDER);
  // Gate F, restated as a number: every firmware-factual claim carries a symbolRef.
  const firmwareFactual = claims.filter((c) => c.type === 'factual' && c.domain === 'firmware').length;
  check(cov.claims.firmwareFactualWithSymbolCitation === firmwareFactual, `GATE F: ${firmwareFactual - cov.claims.firmwareFactualWithSymbolCitation} firmware-factual claim(s) carry no symbolRef`);
}

// ------------------------------------------------------------------ report
for (const w of warnings) console.warn(`WARN  ${w}`);
if (problems.length) {
  console.error(`FAIL  ${rel(docPath)}: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const cov = doc.coverage;
console.log(`OK    ${rel(docPath)}`);
console.log(`      ${cov.lessons.total} lessons (${cov.lessons.polished} polished, ${cov.lessons.outline} outline) · ${cov.lessons.factual} factual / ${cov.lessons.conceptual} conceptual`);
console.log(`      ${cov.steps.total} steps · ${cov.steps.withSuccessCondition} checkable success conditions · ${cov.claims.total} claims`);
console.log(`      GATE F: ${cov.claims.firmwareFactualWithSymbolCitation}/${cov.claims.firmwareFactualWithSymbolCitation} firmware-factual claims carry a resolving symbolRef`);
console.log(`      references resolved: ${cov.symbols.cited} symbols · ${cov.concepts.used}/${cov.concepts.total} concepts · ${cov.teachingNotes.used}/${cov.teachingNotes.total} teaching notes`);
console.log(`      anti-pattern screens: ${SCREENS.length} prose screens + structural rules, 0 hits`);
