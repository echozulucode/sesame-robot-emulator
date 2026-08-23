#!/usr/bin/env node
/**
 * Validate `hardware/assets-inventory.json` (F5).
 *
 * Two jobs:
 *
 *   1. schema conformance, the same check `scripts/extract-stl-geometry.py`
 *      does at generation time — repeated here so it runs on a machine with no
 *      Python, trimesh or STL tree;
 *
 *   2. **provenance resolves in a clean clone.** F5 measured the vendored
 *      `reference/sesame-robot-main/` snapshot, which is gitignored, so every
 *      recorded `path` named a location a fresh checkout does not have. The
 *      measurements were fine and the trees are byte-identical (F2: 129/129),
 *      but a citation you cannot follow is not provenance. This asserts that
 *      every path names the pinned tree `firmware/upstream/`, and — when that
 *      tree is materialised — that each file is still there with the recorded
 *      sha256 and byte count.
 *
 * The second check is the one that would have caught the defect. Nothing in the
 * repository previously read these paths back.
 *
 * Usage: node scripts/validate-assets-inventory.mjs [inventory] [schema]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const invPath = resolve(repoRoot, positional[0] ?? 'hardware/assets-inventory.json');
const schemaPath = resolve(repoRoot, positional[1] ?? 'hardware/assets-inventory.schema.json');
const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    console.error(`FAIL  cannot read ${rel(p)}: ${e.message}`);
    process.exit(1);
  }
};

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

const inv = readJson(invPath);
const schema = readJson(schemaPath);

// ------------------------------------------------------------------- schema
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default ? addFormats.default(ajv) : addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(inv)) {
  for (const e of validate.errors ?? []) {
    problems.push(`schema ${e.instancePath || '(root)'}: ${e.message}`);
  }
}

// ------------------------------------------------------- provenance resolves
const PINNED = 'firmware/upstream/';
const VENDORED = 'reference/sesame-robot-main/';

// Collect every string in the document that looks like a repository path into
// the upstream tree, wherever it sits — `path`, `sourceTree`, prose `source`
// fields. Walking the whole document rather than a known list is deliberate:
// the original defect was in fields nobody thought to enumerate.
const paths = new Set();
// `meta.sourceTreeProvenance` is the one place the vendored path is allowed to
// appear: it is the honest record of what was measured, not a citation.
const { sourceTreeProvenance: _recordedProvenance, ...metaForPathScan } = inv.meta;
(function collect(node) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/(?:reference\/sesame-robot-main|firmware\/upstream)\/[^\s"',)]+/g)) paths.add(m[0]);
    return;
  }
  if (Array.isArray(node)) return node.forEach(collect);
  if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v);
})({ ...inv, meta: metaForPathScan });

check(paths.size > 0, 'no upstream paths found at all — the provenance strings have gone missing');
for (const p of paths) {
  check(!p.startsWith(VENDORED), `provenance still cites the gitignored vendored tree: ${p} (cite ${p.replace(VENDORED, PINNED)})`);
}

const prov = inv.meta.sourceTreeProvenance;
check(!!prov, 'meta.sourceTreeProvenance is missing — the tree that was actually measured must be recorded');
if (prov) {
  const pinPath = resolve(repoRoot, 'firmware/upstream.pin.json');
  if (existsSync(pinPath)) {
    const pin = readJson(pinPath);
    check(prov.upstreamCommit === pin.commit,
      `meta.sourceTreeProvenance.upstreamCommit (${prov.upstreamCommit}) does not match firmware/upstream.pin.json (${pin.commit})`);
  }
  check(prov.citedAs === inv.meta.sourceTree,
    `meta.sourceTreeProvenance.citedAs (${prov.citedAs}) does not match meta.sourceTree (${inv.meta.sourceTree})`);
}

// ---------------------------------------------------- the bytes are still there
// firmware/upstream/ is gitignored (materialised by scripts/fetch-upstream.*),
// so absence is "cannot check here", not "wrong".
const upstreamRoot = resolve(repoRoot, 'firmware/upstream');
let hashed = 0;
const haveTree = existsSync(upstreamRoot);
if (haveTree) {
  const measured = [...inv.parts, ...(inv.cad ?? [])].filter((r) => r.path && r.sha256);
  for (const r of measured) {
    const abs = resolve(repoRoot, r.path);
    if (!existsSync(abs)) { problems.push(`${r.path}: recorded in the inventory but absent from the pinned tree`); continue; }
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    check(actual === r.sha256, `${r.path}: sha256 ${actual} does not match the recorded ${r.sha256}`);
    if (typeof r.bytes === 'number') {
      const n = statSync(abs).size;
      check(n === r.bytes, `${r.path}: ${n} bytes on disk, ${r.bytes} recorded`);
    }
    hashed++;
  }
  check(hashed > 0, 'no measured file had both a path and a sha256 to check');
}

// --------------------------------------------------------------------- report
if (problems.length) {
  console.error(`FAIL  ${rel(invPath)} — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK    ${rel(invPath)} validates against ${rel(schemaPath)}`);
console.log(`      ${inv.parts.length} parts · ${(inv.cad ?? []).length} CAD files · ${paths.size} upstream paths, all citing ${PINNED}`);
console.log(
  haveTree
    ? `      ${hashed} measured file(s) re-hashed against the pinned tree at ${inv.meta.sourceTreeProvenance?.upstreamCommit ?? '(no commit recorded)'} — all match`
    : '      firmware/upstream/ not materialised; byte-level re-check skipped (run scripts/fetch-upstream.ps1)',
);
