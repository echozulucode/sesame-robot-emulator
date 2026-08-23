#!/usr/bin/env node
/**
 * Validates reproducibility.json against reproducibility.schema.json.
 *
 * Contract (F1): every field in the schema must be PRESENT. A value that is not
 * yet known must be `null`, never absent. `additionalProperties: false` catches
 * typo'd keys, and the `required` list catches dropped ones — together they make
 * "we forgot to record that" a hard failure instead of a silent gap.
 *
 * Usage: node scripts/validate-reproducibility.mjs [instance.json] [schema.json]
 * Exit 0 = valid, 1 = invalid or unreadable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const instancePath = resolve(repoRoot, process.argv[2] ?? 'reproducibility.json');
const schemaPath = resolve(repoRoot, process.argv[3] ?? 'reproducibility.schema.json');

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAIL  cannot read ${relative(repoRoot, path)}: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL  ${relative(repoRoot, path)} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

const schema = readJson(schemaPath);
const instance = readJson(instancePath);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

let validate;
try {
  validate = ajv.compile(schema);
} catch (err) {
  console.error(`FAIL  schema ${relative(repoRoot, schemaPath)} did not compile: ${err.message}`);
  process.exit(1);
}

if (!validate(instance)) {
  console.error(`FAIL  ${relative(repoRoot, instancePath)} does not validate against ${relative(repoRoot, schemaPath)}:`);
  for (const e of validate.errors ?? []) {
    const at = e.instancePath || '(root)';
    const extra = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
    console.error(`  - ${at} ${e.message}${extra}`);
  }
  process.exit(1);
}

// Informational: which fields are still unknown. Not an error — Phase 0 fills
// these in as each task lands — but surfacing them keeps the ledger honest.
const unknown = Object.entries(instance)
  .filter(([, v]) => v === null || (Array.isArray(v) && v.length === 0))
  .map(([k]) => k);
const unknownLibs = Object.entries(instance.libraries ?? {})
  .filter(([, v]) => v === null)
  .map(([k]) => `libraries.${k}`);

console.log(`OK    ${relative(repoRoot, instancePath)} validates against ${relative(repoRoot, schemaPath)}`);
const pending = [...unknown, ...unknownLibs];
if (pending.length) {
  console.log(`      ${pending.length} field(s) still unresolved: ${pending.join(', ')}`);
}
