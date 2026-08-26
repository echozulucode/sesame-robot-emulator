#!/usr/bin/env node
/**
 * Validates hardware/source-annotations.json (L3).
 *
 * Four layers, each catching a different class of rot:
 *
 *  1. JSON Schema (draft 2020-12, ajv, strict mode). The schema is
 *     additionalProperties:false throughout, so a typo'd key is a hard failure.
 *
 *  2. Referential integrity inside the file: every concept id used by a symbol,
 *     note or module exists; every symbol id referenced by a note, concept or
 *     module exists; every teaching-note id referenced exists; back-links are
 *     mutually consistent; ids are unique; symbol ranges do not overlap except
 *     where a region is deliberately nested inside a function.
 *
 *  3. Cross-artifact integrity: the pinned commit matches
 *     firmware/upstream.pin.json AND hardware/hardware-map.json, and every
 *     crossRefs entry resolves to a real hardware-map.json entity — a movement
 *     function, a command, a route path, a boot-step order, a face name, a
 *     serial-CLI input.
 *
 *  4. LINE RESOLUTION against the pinned tree (--check-lines, on by default
 *     when the tree is present). This is the strong form of what
 *     validate-hardware-map.mjs --check-lines does: rather than only asserting
 *     that the line number is within the file, it RE-READS the cited line and
 *     compares it to the `text` / `startLineText` / `endLineText` recorded in
 *     the annotation. A citation that has slid by one line fails here.
 *     File sha256 and line counts are checked too, so any drift in the pinned
 *     tree is reported once at the top rather than as fifty line mismatches.
 *
 * Layer 4 is skipped, with a warning, when firmware/upstream/ is absent (a
 * clean clone before scripts/fetch-upstream). Pass --require-lines to make its
 * absence a failure instead.
 *
 * Usage:
 *   node scripts/validate-source-annotations.mjs [annotations.json] [schema.json]
 *   node scripts/validate-source-annotations.mjs --require-lines
 *   node scripts/validate-source-annotations.mjs --no-check-lines
 *
 * Exit 0 = valid, 1 = invalid or unreadable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const argv = process.argv.slice(2);
const REQUIRE_LINES = argv.includes('--require-lines');
const NO_LINES = argv.includes('--no-check-lines');
const positional = argv.filter((a) => !a.startsWith('--'));

const docPath = resolve(repoRoot, positional[0] ?? 'hardware/source-annotations.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/source-annotations.schema.json');

function fail(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }
function readJson(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (err) { fail(`cannot read ${rel(path)}: ${err.message}`); }
  try { return JSON.parse(raw); } catch (err) { fail(`${rel(path)} is not valid JSON: ${err.message}`); }
}

const problems = [];
const warnings = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

const schema = readJson(schemaPath);
const doc = readJson(docPath);

// ---------------------------------------------------------------- layer 1
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
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

// ---------------------------------------------------------------- layer 2
const conceptIds = new Set(doc.concepts.map((c) => c.id));
const symbolIds = new Set(doc.symbols.map((s) => s.id));
const noteIds = new Set(doc.teachingNotes.map((n) => n.id));
const lessonIds = new Set(doc.curriculum.map((m) => m.id));

check(conceptIds.size === doc.concepts.length, 'duplicate concept id');
check(symbolIds.size === doc.symbols.length, 'duplicate symbol id');
check(noteIds.size === doc.teachingNotes.length, 'duplicate teaching-note id');
check(lessonIds.size === doc.curriculum.length, 'duplicate curriculum module id');

const declaredFiles = new Set(doc.meta.filesAnnotated.map((f) => f.file));

for (const s of doc.symbols) {
  check(declaredFiles.has(s.file), `symbol ${s.id}: file ${s.file} is not listed in meta.filesAnnotated`);
  check(s.endLine >= s.startLine, `symbol ${s.id}: endLine ${s.endLine} precedes startLine ${s.startLine}`);
  check(s.lineCount === s.endLine - s.startLine + 1, `symbol ${s.id}: lineCount ${s.lineCount} disagrees with the range`);
  for (const c of s.concepts) check(conceptIds.has(c), `symbol ${s.id}: unknown concept ${c}`);
  for (const n of s.teachingNotes) check(noteIds.has(n), `symbol ${s.id}: unknown teaching note ${n}`);
  for (const l of s.lessons) check(lessonIds.has(l), `symbol ${s.id}: unknown lesson ${l}`);
  if (s.lesson !== null) {
    check(lessonIds.has(s.lesson), `symbol ${s.id}: unknown primary lesson ${s.lesson}`);
    check(s.lessons.includes(s.lesson), `symbol ${s.id}: primary lesson ${s.lesson} is not in lessons[]`);
  } else {
    check(s.lessons.length === 0, `symbol ${s.id}: lesson is null but lessons[] is not empty`);
  }
  if (s.robotPartsTransitive) {
    for (const p of s.robotParts) check(s.robotPartsTransitive.includes(p), `symbol ${s.id}: ${p} is in robotParts but not in robotPartsTransitive`);
  }
  // No-hardware-claims screen. These verbs, applied to the robot, would assert
  // a physical outcome this project can never observe (docs/plan.md).
  const banned = /\b(the servo (?:moved|turned|rotated)|the joint (?:moved|rotated)|the robot (?:walked|stood|waved)|actually (?:moved|rotated)|we measured on hardware|observed at the pin)\b/i;
  check(!banned.test(s.description), `symbol ${s.id}: description asserts a physical outcome, which docs/plan.md forbids`);
}

// Overlap: a symbol may nest inside another (the dispatch regions inside
// loop(), the pin table alongside the servos array) but must not straddle.
const byFile = new Map();
for (const s of doc.symbols) {
  if (!byFile.has(s.file)) byFile.set(s.file, []);
  byFile.get(s.file).push(s);
}
for (const [file, list] of byFile) {
  const sorted = [...list].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]; const b = sorted[j];
      if (b.startLine > a.endLine) break;
      const nested = b.endLine <= a.endLine;
      check(nested, `${file}: symbols ${a.id} (${a.startLine}-${a.endLine}) and ${b.id} (${b.startLine}-${b.endLine}) partially overlap — ranges must nest or be disjoint`);
    }
  }
}

for (const c of doc.concepts) {
  check(symbolIds.has(c.primaryAnchor.symbol), `concept ${c.id}: unknown primaryAnchor symbol ${c.primaryAnchor.symbol}`);
  const anchor = doc.symbols.find((s) => s.id === c.primaryAnchor.symbol);
  if (anchor) {
    check(anchor.file === c.primaryAnchor.file && anchor.startLine === c.primaryAnchor.line,
      `concept ${c.id}: primaryAnchor points at ${c.primaryAnchor.file}:${c.primaryAnchor.line} but symbol ${anchor.id} starts at ${anchor.file}:${anchor.startLine}`);
  }
  for (const sid of c.symbols) {
    check(symbolIds.has(sid), `concept ${c.id}: unknown symbol ${sid}`);
    const s = doc.symbols.find((x) => x.id === sid);
    if (s) check(s.concepts.includes(c.id), `concept ${c.id}: back-link to ${sid} is not mirrored by that symbol's concepts[]`);
  }
  // Inversion must be complete, not merely consistent.
  for (const s of doc.symbols) {
    if (s.concepts.includes(c.id)) check(c.symbols.includes(s.id), `concept ${c.id}: symbol ${s.id} claims this concept but is missing from concepts[].symbols`);
  }
  for (const n of c.teachingNotes) check(noteIds.has(n), `concept ${c.id}: unknown teaching note ${n}`);
  for (const l of c.lessons) check(lessonIds.has(l), `concept ${c.id}: unknown lesson ${l}`);
}

for (const n of doc.teachingNotes) {
  for (const sid of n.symbols) check(symbolIds.has(sid), `${n.id}: unknown symbol ${sid}`);
  for (const cid of n.concepts) check(conceptIds.has(cid), `${n.id}: unknown concept ${cid}`);
  for (const ev of n.evidence) check(declaredFiles.has(ev.file), `${n.id}: evidence cites ${ev.file}, which is not in meta.filesAnnotated`);
  // A defect note must name where it is already tracked; an undocumented
  // "defect" in a teaching artifact is how folklore starts.
  if (n.kind === 'defect') check(n.references.some((r) => /^ISSUE-\d{8}-\d{3}$/.test(r)), `${n.id}: kind "defect" must cite an issue id from docs/issues.yaml`);
}

for (const m of doc.curriculum) {
  for (const cid of m.concepts) check(conceptIds.has(cid), `module ${m.id}: unknown concept ${cid}`);
  for (const sid of m.symbols) {
    check(symbolIds.has(sid), `module ${m.id}: unknown symbol ${sid}`);
    const s = doc.symbols.find((x) => x.id === sid);
    if (s) check(s.lessons.includes(m.id), `module ${m.id}: lists symbol ${sid}, which does not list this module back`);
  }
  for (const nid of m.teachingNotes) check(noteIds.has(nid), `module ${m.id}: unknown teaching note ${nid}`);
  // GATE F, in machine-checkable form.
  if (m.grounding === 'factual') {
    check(m.symbols.length > 0, `module ${m.id}: grounding "factual" with no backing symbol — Gate F requires it be labelled conceptual instead`);
  } else {
    check(typeof m.conceptualReason === 'string' && m.conceptualReason.length > 0,
      `module ${m.id}: grounding "conceptual" must say WHY it cannot be grounded`);
  }
}

// coverage must agree with the data it summarises
check(doc.coverage.symbols.total === doc.symbols.length, `coverage.symbols.total ${doc.coverage.symbols.total} != ${doc.symbols.length} symbols`);
check(doc.coverage.concepts.total === doc.concepts.length, `coverage.concepts.total disagrees with concepts[]`);
check(doc.coverage.teachingNotes.total === doc.teachingNotes.length, `coverage.teachingNotes.total disagrees with teachingNotes[]`);
check(doc.coverage.curriculum.modules === doc.curriculum.length, `coverage.curriculum.modules disagrees with curriculum[]`);
check(doc.coverage.curriculum.conceptual === doc.curriculum.filter((m) => m.grounding === 'conceptual').length, `coverage.curriculum.conceptual is stale`);
check(
  JSON.stringify(doc.coverage.curriculum.conceptualModules) === JSON.stringify(doc.curriculum.filter((m) => m.grounding === 'conceptual').map((m) => m.id)),
  'coverage.curriculum.conceptualModules is stale',
);

// ---------------------------------------------------------------- layer 3
const pinPath = resolve(repoRoot, 'firmware/upstream.pin.json');
if (existsSync(pinPath)) {
  const pin = readJson(pinPath);
  check(doc.meta.upstreamCommit === pin.commit,
    `meta.upstreamCommit ${doc.meta.upstreamCommit} != firmware/upstream.pin.json ${pin.commit}`);
} else {
  warnings.push('firmware/upstream.pin.json missing — commit could not be cross-checked');
}

const hwPath = resolve(repoRoot, 'hardware/hardware-map.json');
if (existsSync(hwPath)) {
  const hw = readJson(hwPath);
  check(doc.meta.upstreamCommit === hw.meta.sourceTree.upstreamCommit,
    `meta.upstreamCommit != hardware-map.json meta.sourceTree.upstreamCommit`);

  const hwMovements = new Set(hw.movements.map((m) => m.function));
  const hwCommands = new Set(hw.commands.vocabulary.map((v) => v.command));
  const hwRoutes = new Set(hw.network.http.routes.map((r) => r.path));
  const hwBoot = new Set(hw.bootOrder.map((b) => b.order));
  const hwFaces = new Set(hw.faces.faces.map((f) => f.name));
  const hwSerial = new Set(hw.commands.serialCli.flatMap((e) => e.input));
  const hwJoints = new Set(hw.servos.order);

  for (const s of doc.symbols) {
    const x = s.crossRefs;
    for (const v of x.movements ?? []) check(hwMovements.has(v), `symbol ${s.id}: crossRefs.movements "${v}" is not a hardware-map movement function`);
    for (const v of x.commands ?? []) check(hwCommands.has(v), `symbol ${s.id}: crossRefs.commands "${v}" is not in hardware-map commands.vocabulary`);
    for (const v of x.routes ?? []) check(hwRoutes.has(v), `symbol ${s.id}: crossRefs.routes "${v}" is not a hardware-map route path`);
    for (const v of x.bootSteps ?? []) check(hwBoot.has(v), `symbol ${s.id}: crossRefs.bootSteps ${v} is not a hardware-map bootOrder order`);
    for (const v of x.faces ?? []) check(hwFaces.has(v), `symbol ${s.id}: crossRefs.faces "${v}" is not a registered face`);
    for (const v of x.serialCli ?? []) check(hwSerial.has(v), `symbol ${s.id}: crossRefs.serialCli "${v}" is not a hardware-map serial CLI input`);
    for (const p of s.robotParts) check(hwJoints.has(p), `symbol ${s.id}: robotPart "${p}" is not a hardware-map joint`);
  }

  // Movement symbols must agree with hardware-map's independently extracted ranges.
  for (const s of doc.symbols) {
    if (s.kind !== 'pose-function' && s.kind !== 'movement-function') continue;
    const mv = hw.movements.find((m) => m.function === s.id);
    if (!mv) { problems.push(`symbol ${s.id}: no hardware-map movement entry`); continue; }
    check(mv.sourceRange.from.line === s.startLine && mv.sourceRange.to.line === s.endLine,
      `symbol ${s.id}: range ${s.startLine}-${s.endLine} disagrees with hardware-map ${mv.sourceRange.from.line}-${mv.sourceRange.to.line}`);
  }

  // Every movement function and every route must be annotated somewhere.
  const annotatedMovements = new Set(doc.symbols.filter((s) => s.kind === 'pose-function' || s.kind === 'movement-function').map((s) => s.id));
  const annotatedElsewhere = new Set(doc.symbols.map((s) => s.id));
  for (const m of hw.movements) {
    check(annotatedMovements.has(m.function) || annotatedElsewhere.has(m.function),
      `hardware-map movement ${m.function} has no annotation`);
  }
  const referencedRoutes = new Set(doc.symbols.flatMap((s) => s.crossRefs.routes ?? []));
  for (const r of hw.network.http.routes) {
    check(referencedRoutes.has(r.path), `hardware-map route ${r.path} is referenced by no annotation`);
  }
} else {
  warnings.push('hardware/hardware-map.json missing — cross-references could not be checked');
}

// ---------------------------------------------------------------- layer 4
const TREE = resolve(repoRoot, 'firmware/upstream');
let lineChecked = 0;
let treeUsed = null;
if (!NO_LINES) {
  if (!existsSync(join(TREE, 'firmware/sesame-firmware-main.ino'))) {
    const msg = `pinned firmware tree absent at ${rel(TREE)} — line resolution NOT verified (run scripts/fetch-upstream.ps1 or .sh)`;
    if (REQUIRE_LINES) problems.push(msg); else warnings.push(msg);
  } else {
    treeUsed = TREE;
    const cache = new Map();
    const linesOf = (file) => {
      if (!cache.has(file)) {
        const p = join(TREE, file);
        if (!existsSync(p)) { cache.set(file, null); return null; }
        const arr = readFileSync(p, 'utf8').split(/\r?\n/);
        if (arr.length && arr[arr.length - 1] === '') arr.pop();
        cache.set(file, arr);
      }
      return cache.get(file);
    };

    // File identity first, so drift is reported once.
    let identityOk = true;
    for (const f of doc.meta.filesAnnotated) {
      const p = join(TREE, f.file);
      if (!existsSync(p)) { problems.push(`meta.filesAnnotated: ${f.file} does not exist under ${rel(TREE)}`); identityOk = false; continue; }
      const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (sha !== f.sha256) {
        problems.push(`${f.file}: sha256 ${sha} != recorded ${f.sha256} — the pinned tree does not match what this file was generated from; re-run scripts/build-source-annotations.mjs`);
        identityOk = false;
      }
      const n = linesOf(f.file).length;
      if (n !== f.lines) { problems.push(`${f.file}: ${n} lines on disk, ${f.lines} recorded`); identityOk = false; }
    }

    if (identityOk) {
      const at = (file, line) => {
        const L = linesOf(file);
        if (!L) return null;
        if (line < 1 || line > L.length) return null;
        return L[line - 1].replace(/\s+$/, '');
      };
      const compare = (what, file, line, expected) => {
        const actual = at(file, line);
        lineChecked++;
        if (actual === null) { problems.push(`${what}: ${file}:${line} is out of range`); return; }
        if (actual !== expected) {
          problems.push(`${what}: ${file}:${line} reads ${JSON.stringify(actual)} but the annotation records ${JSON.stringify(expected)}`);
        }
      };
      for (const s of doc.symbols) {
        compare(`symbol ${s.id} start`, s.file, s.startLine, s.startLineText);
        compare(`symbol ${s.id} end`, s.file, s.endLine, s.endLineText);
      }
      for (const c of doc.concepts) {
        compare(`concept ${c.id} primaryAnchor`, c.primaryAnchor.file, c.primaryAnchor.line, c.primaryAnchor.text);
      }
      for (const n of doc.teachingNotes) {
        for (const ev of n.evidence) compare(`${n.id} evidence`, ev.file, ev.line, ev.text);
      }
      // Coverage line totals are only meaningful against the real tree.
      for (const [file, cov] of Object.entries(doc.coverage.files)) {
        const L = linesOf(file);
        if (!L) { problems.push(`coverage.files: ${file} not found under ${rel(TREE)}`); continue; }
        check(cov.totalLines === L.length, `coverage.files[${file}].totalLines ${cov.totalLines} != ${L.length} on disk`);
        const mask = new Array(L.length + 1).fill(false);
        for (const s of doc.symbols) {
          if (s.file !== file) continue;
          for (let i = s.startLine; i <= s.endLine; i++) mask[i] = true;
        }
        check(cov.annotatedLines === mask.filter(Boolean).length, `coverage.files[${file}].annotatedLines is stale`);
      }
    }
  }
}

// ---------------------------------------------------------------- report
if (problems.length) {
  console.error(`FAIL  ${rel(docPath)} passed schema validation but failed ${problems.length} check(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`OK    ${rel(docPath)} validates against ${rel(schemaPath)}`);
console.log(
  `      ${doc.symbols.length} symbols across ${doc.meta.filesAnnotated.length} files · ` +
  `${doc.concepts.length} concepts (${doc.coverage.concepts.verbatimFromReport} verbatim from the report) · ` +
  `${doc.teachingNotes.length} teaching notes · ${doc.curriculum.length} curriculum modules`,
);
console.log(
  `      curriculum grounding: ${doc.coverage.curriculum.factual} factual, ${doc.coverage.curriculum.conceptual} conceptual ` +
  `(${doc.coverage.curriculum.conceptualModules.join(', ')})`,
);
if (treeUsed) {
  console.log(`      ${lineChecked} cited lines re-read and matched against ${rel(treeUsed)} at ${doc.meta.upstreamCommit.slice(0, 12)}`);
} else {
  console.log('      line resolution NOT verified (pinned tree absent)');
}
for (const w of warnings) console.log(`WARN  ${w}`);
