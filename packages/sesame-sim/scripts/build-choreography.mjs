#!/usr/bin/env node
/**
 * Project `hardware/hardware-map.json` into `src/generated/choreography.ts`.
 *
 * Why generate a `.ts` file rather than import the JSON directly:
 *
 *   - `@sesame-lab/sesame-sim` has to run in a browser (V3 drives the R3F robot
 *     from it), so it cannot read the 300 KB map off disk at runtime.
 *   - Importing the JSON with `resolveJsonModule` would make `tsc` synthesise a
 *     structural `.d.ts` for all 395 steps. A generated module typed as
 *     `Choreography` emits one line of declaration instead.
 *
 * The projection is lossy on purpose — `expandedFrom` / `expansionNote`, which
 * are long repeated prose strings, are dropped — but every step keeps its
 * `file:line` provenance, which is the part that has to survive.
 *
 * Usage:
 *   node scripts/build-choreography.mjs            # regenerate
 *   node scripts/build-choreography.mjs --check    # fail if stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const REPO = path.resolve(PKG, '..', '..');
const MAP = path.join(REPO, 'hardware', 'hardware-map.json');
const OUT = path.join(PKG, 'src', 'generated', 'choreography.ts');

const CHECK = process.argv.includes('--check');

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));

const src = (s) => {
  if (!s || typeof s.file !== 'string' || typeof s.line !== 'number') {
    throw new Error(`step is missing file:line provenance: ${JSON.stringify(s)}`);
  }
  return { file: s.file, line: s.line };
};

let stepCount = 0;

/** Narrow each step to the fields the interpreter needs, and no others. */
function projectStep(step, owner) {
  stepCount++;
  const source = src(step.source);
  switch (step.type) {
    case 'log':
      return { type: 'log', text: step.text, source };
    case 'face':
      return { type: 'face', name: step.name, mode: step.mode ?? null, source };
    case 'servo':
      return {
        type: 'servo', joint: step.joint, index: step.index,
        angleDeg: step.angleDeg, source,
      };
    case 'delay':
      return { type: 'delay', ms: step.ms, via: step.via ?? 'delayWithFace', source };
    case 'repeat':
      return {
        type: 'repeat',
        count: step.count ?? null,
        countDefault: step.countDefault ?? null,
        countRef: step.countRef ?? null,
        steps: step.steps.map((s) => projectStep(s, owner)),
        source,
      };
    case 'conditional':
      return {
        type: 'conditional', condition: step.condition,
        steps: step.steps.map((s) => projectStep(s, owner)), source,
      };
    case 'call':
      return { type: 'call', function: step.function, args: step.args ?? null, source };
    case 'clearCommandIf':
      return { type: 'clearCommandIf', command: step.command, source };
    case 'interruptCheck':
      return {
        type: 'interruptCheck', command: step.command,
        durationMsDefault: step.durationMsDefault ?? null,
        durationMsRef: step.durationMsRef ?? null,
        source,
      };
    case 'state':
      return { type: 'state', variable: step.variable, value: step.value, source };
    default:
      throw new Error(`unhandled step type '${step.type}' in ${owner}`);
  }
}

const movements = map.movements.map((m) => ({
  function: m.function,
  kind: m.kind,
  signature: m.signature,
  loops: m.loops,
  interruptible: m.interruptible,
  triggeredByCommand: m.triggeredByCommand ?? [],
  defaultArgs: m.defaultArgs ?? null,
  note: m.note ?? null,
  source: src(m.source),
  sourceRange: { from: src(m.sourceRange.from), to: src(m.sourceRange.to) },
  steps: m.steps.map((s) => projectStep(s, m.function)),
}));

// Every joint/index pair the extractor emitted must agree with the enum order,
// or the whole model is wired to the wrong servos.
const order = map.servos.order;
for (const m of movements) {
  const walk = (steps) => {
    for (const s of steps) {
      if (s.type === 'servo' && order[s.index] !== s.joint) {
        throw new Error(`${m.function}: joint/index disagreement ${s.joint}@${s.index}`);
      }
      if (s.steps) walk(s.steps);
    }
  };
  walk(m.steps);
}

const sc = map.servos.servoConfig;
const data = {
  meta: {
    generatedBy: 'packages/sesame-sim/scripts/build-choreography.mjs',
    sourceFile: 'hardware/hardware-map.json',
    upstreamCommit: map.meta.sourceTree.upstreamCommit,
    movementCount: movements.length,
    stepCount,
  },
  movements,
  angleClamp: { min: sc.angleClamp.min, max: sc.angleClamp.max },
  motorCurrentDelayMs: sc.motorCurrentDelay.defaultMs,
  subtrimDefaults: sc.subtrim.defaults,
  jointOrder: order,
};

const banner = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by \`packages/sesame-sim/scripts/build-choreography.mjs\` from
 * \`hardware/hardware-map.json\` (upstream ${data.meta.upstreamCommit}).
 * ${data.meta.movementCount} movement functions, ${data.meta.stepCount} steps, every one
 * carrying the \`file:line\` it was extracted from.
 *
 * Regenerate:  pnpm --filter @sesame-lab/sesame-sim build:choreography
 * Check:       pnpm --filter @sesame-lab/sesame-sim validate:choreography
 *
 * \`choreography-drift.test.ts\` re-derives this from the JSON on every test run,
 * so an edit here fails the suite rather than silently changing the robot.
 */
import type { Choreography } from '../choreography-types.js';

export const CHOREOGRAPHY: Choreography = `;

const text = `${banner}${JSON.stringify(data, null, 2)};\n`;

if (CHECK) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing !== text) {
    console.error('[choreography] src/generated/choreography.ts is STALE — run build:choreography');
    process.exit(1);
  }
  console.log(`[choreography] up to date (${data.meta.movementCount} movements, ${stepCount} steps)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`[choreography] wrote src/generated/choreography.ts (${data.meta.movementCount} movements, ${stepCount} steps)`);
}
