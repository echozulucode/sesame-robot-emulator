#!/usr/bin/env node
/**
 * Validates hardware/hardware-map.json against hardware/hardware-map.schema.json (F4).
 *
 * Two layers of checking:
 *
 *  1. JSON Schema (draft 2020-12, ajv, strict mode). The schema is
 *     `additionalProperties: false` throughout, so a typo'd key is a hard
 *     failure rather than a silently ignored field.
 *
 *  2. Semantic invariants the schema cannot express, and which matter because
 *     getting them wrong would be silently wrong rather than loudly wrong:
 *       - exactly one board is active
 *       - the servo order is the firmware enum order, never re-sorted
 *       - every joint's per-board pin matches that board's servoPins[index]
 *       - bootOrder is contiguous and starts at 1
 *       - every movement `call` target resolves
 *       - every movement `face` name is a registered face
 *       - every command's movementFunction resolves
 *       - every provenance path points at a file listed in meta.sourceTree.filesRead
 *       - every `unresolved` entry names a real subject prefix
 *
 * Provenance line numbers are checked against the real firmware tree only when
 * it is available locally; see --check-lines below.
 *
 * Usage:
 *   node scripts/validate-hardware-map.mjs [map.json] [schema.json]
 *   node scripts/validate-hardware-map.mjs --check-lines[=<firmware tree root>]
 *
 * --check-lines additionally verifies that every cited file:line exists in the
 * firmware tree (default search: firmware/upstream, then
 * reference/sesame-robot-main). Without it, only structure is checked.
 *
 * Exit 0 = valid, 1 = invalid or unreadable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const argv = process.argv.slice(2);
const lineFlag = argv.find((a) => a.startsWith('--check-lines'));
const positional = argv.filter((a) => !a.startsWith('--'));

const mapPath = resolve(repoRoot, positional[0] ?? 'hardware/hardware-map.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/hardware-map.schema.json');

const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

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

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

const schema = readJson(schemaPath);
const map = readJson(mapPath);

// ---------------------------------------------------------------- layer 1
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });

let validate;
try {
  validate = ajv.compile(schema);
} catch (err) {
  fail(`schema ${rel(schemaPath)} did not compile: ${err.message}`);
}

if (!validate(map)) {
  console.error(`FAIL  ${rel(mapPath)} does not validate against ${rel(schemaPath)}:`);
  for (const e of validate.errors ?? []) {
    const at = e.instancePath || '(root)';
    const extra = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
    console.error(`  - ${at} ${e.message}${extra}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------- layer 2
const FIRMWARE_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'];

// boards
const active = map.boards.filter((b) => b.active);
check(active.length === 1, `expected exactly 1 active board, found ${active.length}`);
for (const b of map.boards) {
  check(b.active !== b.servoPinsCommentedOut || b.servoPins.length !== 8,
    `board ${b.id}: active=${b.active} but servoPinsCommentedOut=${b.servoPinsCommentedOut} — a board cannot be both`);
  check(new Set(b.servoPins).size === 8, `board ${b.id}: servoPins contains duplicates`);
}
const boardIds = new Set(map.boards.map((b) => b.id));

// servo order + per-board pin cross-check
check(
  JSON.stringify(map.servos.order) === JSON.stringify(FIRMWARE_ORDER),
  `servos.order is ${JSON.stringify(map.servos.order)} — must be the firmware enum order ${JSON.stringify(FIRMWARE_ORDER)}. Do NOT "fix" this to alphabetical or geometric.`
);
map.servos.joints.forEach((j, i) => {
  check(j.index === i, `servos.joints[${i}].index is ${j.index}`);
  check(j.firmwareName === FIRMWARE_ORDER[i], `servos.joints[${i}] is ${j.firmwareName}, expected ${FIRMWARE_ORDER[i]}`);
  for (const board of map.boards) {
    check(
      j.pinsByBoard[board.id] === board.servoPins[i],
      `servos.joints[${i}] (${j.firmwareName}) pin for ${board.id} is ${j.pinsByBoard[board.id]} but boards[${board.id}].servoPins[${i}] is ${board.servoPins[i]}`
    );
  }
  for (const id of Object.keys(j.pinsByBoard)) {
    check(boardIds.has(id), `servos.joints[${i}] references unknown board id "${id}"`);
  }
});
check(
  map.servos.servoConfig.attachMinPulseUs < map.servos.servoConfig.attachMaxPulseUs,
  'servoConfig attach pulse range is inverted'
);

// boot order
map.bootOrder.forEach((s, i) => check(s.order === i + 1, `bootOrder[${i}].order is ${s.order}, expected ${i + 1}`));
check(map.bootOrder.some((s) => s.bootBlocker), 'bootOrder records no boot blocker at all — the SSD1306 hard-fail should be one');

// movements: referential integrity
const movementNames = new Set(map.movements.map((m) => m.function));
const faceNames = new Set(map.faces.faces.map((f) => f.name));
const KNOWN_HELPERS = new Set(['scheduleNextIdleBlink']);

function walkSteps(steps, fn, path) {
  steps.forEach((s, i) => {
    fn(s, `${path}[${i}]`);
    if (Array.isArray(s.steps)) walkSteps(s.steps, fn, `${path}[${i}].steps`);
    if (Array.isArray(s.elseSteps)) walkSteps(s.elseSteps, fn, `${path}[${i}].elseSteps`);
  });
}

let stepCount = 0;
for (const m of map.movements) {
  walkSteps(m.steps, (s, path) => {
    stepCount++;
    if (s.type === 'call') {
      check(movementNames.has(s.function) || KNOWN_HELPERS.has(s.function), `${path}: call target "${s.function}" is not a documented movement or known helper`);
    }
    if (s.type === 'face') {
      check(faceNames.has(s.name), `${path}: face "${s.name}" is not in faces.faces[]`);
    }
    if (s.type === 'servo') {
      check(FIRMWARE_ORDER[s.index] === s.joint, `${path}: joint ${s.joint} paired with index ${s.index}`);
    }
  }, `movements.${m.function}.steps`);
  // A movement flagged interruptible must actually contain interrupt points, and vice versa.
  let hasIC = false;
  walkSteps(m.steps, (s) => { if (s.type === 'interruptCheck') hasIC = true; }, '');
  check(hasIC === m.interruptible, `movements.${m.function}: interruptible=${m.interruptible} but interruptCheck steps present=${hasIC}`);
}

// commands
for (const c of map.commands.vocabulary) {
  if (c.movementFunction) check(movementNames.has(c.movementFunction), `commands.vocabulary "${c.command}" -> unknown function ${c.movementFunction}`);
}
for (const c of map.commands.serialCli) {
  if (c.movementFunction) check(movementNames.has(c.movementFunction), `commands.serialCli "${c.input[0]}" -> unknown function ${c.movementFunction}`);
}

// faces
check(map.faces.count === map.faces.faces.length, `faces.count (${map.faces.count}) != faces.faces.length (${map.faces.faces.length})`);
for (const f of map.faces.faces) {
  check(f.frames.length === f.frameCount, `faces "${f.name}": frames.length ${f.frames.length} != frameCount ${f.frameCount}`);
  check(f.animated === f.frameCount > 1, `faces "${f.name}": animated=${f.animated} but frameCount=${f.frameCount}`);
  check(f.baseBitmapDefined === f.frameCount > 0, `faces "${f.name}": baseBitmapDefined=${f.baseBitmapDefined} but frameCount=${f.frameCount}`);
  f.frames.forEach((fr, i) => check(fr.index === i, `faces "${f.name}": frame ${i} has index ${fr.index}`));
}

// unresolved subjects must point somewhere real
const topLevel = new Set(Object.keys(map));
for (const u of map.unresolved) {
  const root = u.subject.split(/[.[]/)[0];
  check(topLevel.has(root), `unresolved "${u.id}": subject "${u.subject}" does not start at a top-level section`);
}

// ------------------------------------------------- provenance path coverage
const declaredFiles = new Set(map.meta.sourceTree.filesRead.map((f) => f.file));
const citations = [];
(function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node && typeof node === 'object') {
    if (typeof node.file === 'string' && Number.isInteger(node.line) && Object.keys(node).length === 2) {
      citations.push(node);
      return;
    }
    for (const v of Object.values(node)) collect(v);
  }
})(map);

check(citations.length > 0, 'no provenance citations found at all');
for (const c of citations) {
  check(declaredFiles.has(c.file), `provenance cites "${c.file}", which is not listed in meta.sourceTree.filesRead`);
}

// ------------------------------------------------- optional line existence
let lineCheckRoot = null;
if (lineFlag) {
  const explicit = lineFlag.includes('=') ? lineFlag.split('=')[1] : null;
  const candidates = explicit
    ? [resolve(repoRoot, explicit)]
    : [resolve(repoRoot, 'firmware/upstream'), resolve(repoRoot, 'reference/sesame-robot-main')];
  lineCheckRoot = candidates.find((c) => existsSync(join(c, 'firmware/sesame-firmware-main.ino'))) ?? null;
  if (!lineCheckRoot) {
    problems.push(`--check-lines requested but no firmware tree found (looked in: ${candidates.map(rel).join(', ')})`);
  } else {
    const lineCounts = new Map();
    for (const c of citations) {
      if (!lineCounts.has(c.file)) {
        const p = join(lineCheckRoot, c.file);
        if (!existsSync(p)) { lineCounts.set(c.file, 0); continue; }
        lineCounts.set(c.file, readFileSync(p, 'utf8').split(/\r?\n/).length);
      }
      const n = lineCounts.get(c.file);
      check(n > 0, `--check-lines: cited file ${c.file} not found under ${rel(lineCheckRoot)}`);
      check(c.line <= n, `--check-lines: ${c.file}:${c.line} is past end of file (${n} lines)`);
    }
  }
}

// ---------------------------------------------------------------- report
if (problems.length) {
  console.error(`FAIL  ${rel(mapPath)} passed schema validation but failed ${problems.length} semantic check(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`OK    ${rel(mapPath)} validates against ${rel(schemaPath)}`);
console.log(
  `      ${map.boards.length} boards (active: ${active[0].id}) · ${map.servos.joints.length} servos [${map.servos.order.join(',')}] · ` +
  `${map.network.http.routes.length} HTTP routes · ${map.movements.length} movement functions (${stepCount} steps) · ` +
  `${map.faces.faces.length} faces · ${map.bootOrder.length} boot steps · ${map.commands.vocabulary.length} commands`
);
console.log(`      ${citations.length} provenance citations${lineCheckRoot ? `, line numbers verified against ${rel(lineCheckRoot)}` : ' (structure only — pass --check-lines to verify line numbers)'}`);
if (map.unresolved.length) {
  console.log(`      ${map.unresolved.length} unresolved item(s): ${map.unresolved.map((u) => u.id).join(', ')}`);
  const blocking = map.unresolved.filter((u) => u.blocking);
  if (blocking.length) console.log(`      ${blocking.length} of them BLOCKING: ${blocking.map((u) => u.id).join(', ')}`);
}
