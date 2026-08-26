#!/usr/bin/env node
/**
 * Project `hardware/lessons.json` (L5) into a typed module the app can import,
 * exactly the way `build-source-annotations-module.mjs` projects L3 and
 * `build-architecture-graph.mjs` projects `hardware/hardware-map.json`.
 *
 * Why a generator and not a JSON import:
 *
 *  - `--check` runs inside `pnpm --filter @sesame-lab/web test`, so the runner
 *    cannot drift from the artefact it claims to be playing;
 *  - the emitted module carries `readonly` types and *unions* — a step whose
 *    `check.type` is not one of the 34 declared types is a compile error here
 *    rather than a silently-skipped check in a browser;
 *  - a raw JSON import would widen every `"factual"` to `string`, and the whole
 *    conceptual/factual badge decision hangs off that literal.
 *
 * Three things are added to L5's data, and nothing else:
 *
 *  1. `BOOT_ORDER`, lifted out of `hardware/hardware-map.json` → `bootOrder[]`,
 *     because `boot-halt` and `boot-step-reached` name a `bootOrder` index and
 *     the app has no other way to resolve one. The halt message is **extracted
 *     from the note** rather than typed in, so it cannot drift from the map.
 *  2. `LESSON_BY_ID`, a lookup.
 *  3. `IMPLEMENTED_CHECK_TYPES` / `IMPLEMENTED_CONTROL_KINDS` are *not* here —
 *     they live in `src/lessons/registry.ts` beside the code that implements
 *     them, so a check cannot be declared implemented by a generator.
 *
 * Two invariants are asserted at generation time, and the build fails on either:
 *
 *  - every lesson's `grounding` equals its `curriculum[]` entry's grounding in
 *    `hardware/source-annotations.json` (L4 §6.3: three of the seven conceptual
 *    modules DO carry symbols, so a UI that badged on `symbols: []` would
 *    mislabel three — the badge has to come from `grounding`, and `grounding`
 *    has to come from the curriculum);
 *  - `meta.upstreamCommit` equals the one `architecture-graph.ts` pins, so a
 *    lesson citation's line numbers and a symbol range are offsets into the
 *    same tree.
 *
 * Regenerate: node apps/web/scripts/build-lessons-module.mjs
 * Check:      node apps/web/scripts/build-lessons-module.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '../..');
const LESSONS = path.join(REPO, 'hardware/lessons.json');
const ANNOTATIONS = path.join(REPO, 'hardware/source-annotations.json');
const HARDWARE_MAP = path.join(REPO, 'hardware/hardware-map.json');
const OUT = path.join(APP, 'src/generated/lessons.ts');
const CHECK = process.argv.includes('--check');

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};

const lessons = JSON.parse(fs.readFileSync(LESSONS, 'utf8'));
const annotations = JSON.parse(fs.readFileSync(ANNOTATIONS, 'utf8'));
const hardwareMap = JSON.parse(fs.readFileSync(HARDWARE_MAP, 'utf8'));

// ---------------------------------------------------------------- invariants

const graphText = fs.readFileSync(path.join(APP, 'src/generated/architecture-graph.ts'), 'utf8');
const graphCommit = /export const UPSTREAM_COMMIT = "([0-9a-f]{40})"/.exec(graphText)?.[1] ?? null;
if (graphCommit !== lessons.meta.upstreamCommit) {
  fail(
    `lessons.json pins ${lessons.meta.upstreamCommit} but architecture-graph.ts pins ${graphCommit}. ` +
      `A lesson citation's startLine and a symbol range would be offsets into two different trees.`,
  );
}

const curriculumById = new Map(annotations.curriculum.map((m) => [m.id, m]));
for (const lesson of lessons.lessons) {
  const entry = curriculumById.get(lesson.curriculumRef);
  if (entry === undefined) {
    fail(`lesson ${lesson.id} names curriculumRef ${lesson.curriculumRef}, which is not in source-annotations.json`);
  }
  if (entry.grounding !== lesson.grounding) {
    fail(
      `lesson ${lesson.id} declares grounding "${lesson.grounding}" but curriculum[${lesson.curriculumRef}] ` +
        `says "${entry.grounding}". The conceptual badge is driven by this field and must not be able to drift.`,
    );
  }
}

const conceptualWithSymbols = lessons.lessons
  .filter((l) => l.grounding === 'conceptual' && (curriculumById.get(l.curriculumRef)?.symbols ?? []).length > 0)
  .map((l) => l.id);
if (conceptualWithSymbols.length === 0) {
  fail(
    'no conceptual module carries symbols. L4 §6.3 measured three that do; if that has changed, the ' +
      'badge-on-grounding argument needs rewriting rather than silently weakening.',
  );
}

// ------------------------------------------------------------------ bootOrder
//
// `boot-halt` requires an `expectLogContains`. That string is real firmware
// output recorded in the map's own note; extract it rather than typing it in,
// so the two cannot disagree.
const bootOrder = hardwareMap.bootOrder.map((entry) => {
  const halt = entry.bootBlocker === true ? /prints "([^"]+)"/.exec(entry.note ?? '')?.[1] ?? null : null;
  if (entry.bootBlocker === true && halt === null) {
    fail(`bootOrder ${entry.order} is a bootBlocker but its note names no printed line`);
  }
  return {
    order: entry.order,
    operation: entry.operation,
    subsystem: entry.subsystem,
    file: entry.source.file,
    line: entry.source.line,
    bootBlocker: entry.bootBlocker === true,
    haltMessage: halt,
    note: entry.note ?? null,
  };
});

// ------------------------------------------------------------------- emitting

const j = (value) => JSON.stringify(value);
const union = (values) => values.map(j).join(' | ');

const v = lessons.vocabularies;
const levelIds = v.explanationLevels.map((e) => e.id);
const stepKindIds = v.stepKinds.map((e) => e.id);
const controlKindIds = v.controlKinds.map((e) => e.id);
const checkTypeIds = v.checkTypes.map((e) => e.id);
const claimDomainIds = v.claimDomains.map((e) => e.id);
const observabilityIds = v.observability.map((e) => e.id);
const citationKindIds = v.citationKinds.map((e) => e.id);
const traceLayerIds = v.traceLayers.map((e) => e.id);

const out = `/**
 * GENERATED by apps/web/scripts/build-lessons-module.mjs — do not edit.
 *
 * Projected verbatim from \`hardware/lessons.json\` (L5): ${lessons.coverage.lessons.total} lessons ·
 * ${lessons.coverage.steps.total} steps · ${lessons.coverage.steps.withSuccessCondition} checkable success conditions ·
 * ${lessons.vocabularies.checkTypes.length} declared check types · ${lessons.vocabularies.controlKinds.length} declared control kinds.
 *
 * The generator asserts two things the runner's honesty rests on:
 *
 *  - every lesson's \`grounding\` equals its \`curriculum[]\` entry's in
 *    \`hardware/source-annotations.json\`. The \`conceptual\` badge is driven by
 *    this field and NOT by \`links.symbols.length === 0\`: ${conceptualWithSymbols.length} of the
 *    ${lessons.coverage.lessons.conceptual} conceptual modules (${conceptualWithSymbols.map((id) => `\`${id}\``).join(', ')})
 *    do carry symbols, so badging on emptiness would mislabel them.
 *  - \`meta.upstreamCommit\` equals the commit \`architecture-graph.ts\` pins.
 *
 * Which of the declared check types and control kinds are actually IMPLEMENTED
 * is deliberately not stated here — see \`src/lessons/registry.ts\`, which sits
 * beside the code that implements them.
 *
 * Regenerate: node apps/web/scripts/build-lessons-module.mjs
 * Check:      node apps/web/scripts/build-lessons-module.mjs --check
 */

/** The three explanatory registers. Exactly one is ever on screen. */
export type ExplanationLevelId = ${union(levelIds)};

export type LessonStepKind = ${union(stepKindIds)};

/** Every control a step may ask for. Not all of them are built; see the registry. */
export type ControlKind = ${union(controlKindIds)};

/** Every declared success check. Not all of them are built; see the registry. */
export type CheckTypeId = ${union(checkTypeIds)};

export type ClaimDomain = ${union(claimDomainIds)};

export type Observability = ${union(observabilityIds)};

export type CitationKind = ${union(citationKindIds)};

export type LessonTraceLayer = ${union(traceLayerIds)};

export type ProvenanceBadgeId = ${union(v.provenanceBadges)};

export type LessonGrounding = 'factual' | 'conceptual';

export type LessonStatus = 'polished' | 'outline';

export interface VocabularyEntry {
  readonly id: string;
  /** Present on the explanation levels; the step and control kinds have none. */
  readonly label?: string;
  readonly description: string;
}

export interface CheckTypeSpec {
  readonly id: CheckTypeId;
  /** The parameters this check's evaluator may read. L5's contract. */
  readonly requires: readonly string[];
  readonly description: string;
}

/**
 * One of the seven declared faults.
 *
 * \`injectorIsLabFeature\` is the field that separates "this robot is genuinely
 * broken" from "we broke it for you". Three of the seven are \`false\`: the blank
 * \`stand\` face, the command word that never clears and the unescaped
 * \`/api/status\` are the shipped firmware's own behaviour, and a learner who
 * cannot tell those apart from an injection has learned the wrong lesson.
 */
export interface DeclaredFault {
  readonly id: string;
  readonly title: string;
  readonly causeSymbol: string;
  readonly teachingNote: string;
  readonly injectorIsLabFeature: boolean;
  readonly note: string;
}

/**
 * A citation on a claim or a goDeeper block.
 *
 * One interface rather than a discriminated union: the six kinds share almost
 * nothing, and the renderer branches on \`kind\` anyway. Every field a kind does
 * not carry is absent, which is why they are all optional — and several are
 * \`| null\` because the artefact writes an explicit null where a value is
 * genuinely unknown rather than omitting the key.
 */
export interface LessonCitation {
  readonly kind: CitationKind;
  /** symbol */
  readonly symbol?: string;
  readonly file?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly signature?: string;
  /** hardware-map */
  readonly path?: string;
  /** library — cited by library + version + path-within-library + line. */
  readonly library?: string;
  readonly version?: string;
  readonly line?: number | null;
  readonly text?: string;
  /** document */
  readonly doc?: string;
  readonly section?: string | null;
  readonly evidenceTag?: string | null;
  /** issue */
  readonly id?: string;
  /** teaching-note */
  readonly note?: string | null;
  readonly title?: string | null;
}

/**
 * What a step asserts, and on whose authority.
 *
 * \`boundaryNote\` is not a caveat and must not be rendered as one. It is where a
 * FACTUAL step admits that the fact is about a library, an emulator or Sesame
 * Lab itself rather than about Sesame's firmware — a real epistemic boundary,
 * and the runner gives it its own register.
 */
export interface LessonClaim {
  readonly type: 'factual' | 'conceptual';
  readonly domain: ClaimDomain;
  readonly text: string;
  readonly citations: readonly LessonCitation[];
  readonly boundaryNote: string | null;
  readonly conceptualReason: string | null;
  readonly observability: Observability | null;
  readonly groundingDisclosure: boolean;
}

export interface LessonExplanation {
  readonly beginner12: string;
  readonly beginnerProgrammer: string | null;
  readonly architecture: string | null;
}

export interface LessonGoDeeper {
  readonly title: string;
  readonly body: string;
  readonly citations: readonly LessonCitation[];
}

export interface LessonManipulate {
  readonly control: ControlKind;
  readonly target: string;
  readonly affordance: string;
  readonly bounds: Readonly<Record<string, unknown>> | null;
}

export interface LessonObservable {
  readonly traceLayer: LessonTraceLayer;
  readonly what: string;
}

export interface LessonExpect {
  readonly text: string;
  readonly observable: readonly LessonObservable[];
}

/**
 * A success condition.
 *
 * \`type\` is one of the ${checkTypeIds.length} declared kinds; the remaining keys are that kind's
 * \`requires\` parameters. There is deliberately no \`clicked-next\`, no time-based
 * and no acknowledgement-based check type in the vocabulary — L5 made a timer
 * gate structurally impossible and the runner does not add one back.
 */
export interface LessonCheck {
  readonly type: CheckTypeId;
  readonly [param: string]: unknown;
}

export interface LessonSuccess {
  readonly id: string;
  readonly description: string;
  readonly check: LessonCheck;
  readonly hint: string;
  /** Present on every \`debug\` step. Debugging is not framed as failure. */
  readonly failureIsNormal: string | null;
}

export interface LessonLinks {
  readonly symbols: readonly string[];
  readonly concepts: readonly string[];
  readonly teachingNotes: readonly string[];
  readonly robotParts: readonly string[];
  readonly traceLayers: readonly LessonTraceLayer[];
  readonly hardwareMap: readonly string[];
}

export interface LessonStep {
  readonly id: string;
  readonly order: number;
  readonly kind: LessonStepKind;
  readonly title: string;
  /** \`full\` = all three levels and a cause-and-effect. \`outline\` = not written yet. */
  readonly detail: 'full' | 'outline';
  readonly explanation: LessonExplanation;
  readonly goDeeper: LessonGoDeeper | null;
  readonly claim: LessonClaim;
  readonly manipulate: LessonManipulate;
  /** \`null\` on outline steps: the cause-and-effect text is unwritten. */
  readonly expect: LessonExpect | null;
  readonly success: LessonSuccess;
  readonly links: LessonLinks;
}

export interface LessonChallenge {
  readonly id: string;
  readonly level: string;
  readonly title: string;
  readonly coreConcept: string;
  /**
   * The success id that unlocks it. A challenge opens because the learner
   * DEMONSTRATED something, never because time passed — and a step that was
   * skipped rather than passed does not satisfy this.
   */
  readonly unlockedBy: string;
  readonly success: LessonSuccess;
  readonly order: number;
}

export interface Lesson {
  readonly id: string;
  readonly order: number;
  readonly curriculumRef: string;
  readonly supersedes: string | null;
  readonly title: string;
  readonly module: string;
  readonly mainExperience: string;
  readonly realSesameConcept: string;
  readonly status: LessonStatus;
  /** Copied from \`curriculum[].grounding\`. The badge is driven by THIS. */
  readonly grounding: LessonGrounding;
  /** A factual module marking a real boundary that does not disqualify it. */
  readonly groundingNote: string | null;
  readonly conceptualReason: string | null;
  readonly learningGoal: string;
  readonly willBeAbleTo: readonly string[];
  readonly prerequisites: readonly string[];
  readonly unlocks: readonly string[];
  readonly estimatedMinutes: number;
  readonly labHandoff: string;
  readonly openQuestions: readonly string[];
  readonly links: LessonLinks;
  readonly steps: readonly LessonStep[];
  readonly challenges: readonly LessonChallenge[];
}

/** One step of \`setup()\`, from \`hardware-map.json\` → \`bootOrder\`. */
export interface BootStep {
  readonly order: number;
  readonly operation: string;
  readonly subsystem: string;
  readonly file: string;
  readonly line: number;
  /** True for the ONE step whose failure stops boot dead: \`display.begin()\`. */
  readonly bootBlocker: boolean;
  /** The line the firmware prints before \`while (1);\`. Extracted from the note. */
  readonly haltMessage: string | null;
  readonly note: string | null;
}

export const LESSONS_UPSTREAM_COMMIT = ${j(lessons.meta.upstreamCommit)} as const;

export const LESSON_CONTENT_VERSION = ${j(lessons.meta.schemaVersion)} as const;

export const LESSON_LEARNER = ${j(lessons.meta.learner)} as const;

export const EXPLANATION_LEVELS: readonly VocabularyEntry[] = ${j(v.explanationLevels)};

export const STEP_KINDS: readonly VocabularyEntry[] = ${j(v.stepKinds)};

export const CONTROL_KINDS: readonly VocabularyEntry[] = ${j(v.controlKinds)};

export const CHECK_TYPES: readonly CheckTypeSpec[] = [
${v.checkTypes.map((c) => `  ${j(c)},`).join('\n')}
];

export const CHECK_TYPE_BY_ID: ReadonlyMap<string, CheckTypeSpec> = new Map(
  CHECK_TYPES.map((c) => [c.id, c]),
);

/** The seven declared faults. Three of them are NOT injected — see the type doc. */
export const DECLARED_FAULTS: readonly DeclaredFault[] = [
${v.faults.map((f) => `  ${j(f)},`).join('\n')}
];

/**
 * L5's recomputed PWM model.
 *
 * Present so the runner can CHECK its own arithmetic against the artefact —
 * never so it can display these numbers instead of computing them.
 * \`quantiseCommandedAngle()\` in \`@sesame-lab/sesame-model\` is the authority,
 * and a disagreement between the two is a loud failure, not a fallback.
 */
export const LESSON_PWM_MODEL = ${j(v.pwmModel)} as const;

export const PROVENANCE_BADGE_IDS: readonly ProvenanceBadgeId[] = ${j(v.provenanceBadges)};

export const LESSON_COVERAGE = ${j(lessons.coverage)} as const;

export const BOOT_ORDER: readonly BootStep[] = [
${bootOrder.map((b) => `  ${j(b)},`).join('\n')}
];

export const LESSONS: readonly Lesson[] = [
${lessons.lessons.map((l) => `  ${j(l)},`).join('\n')}
];

export const LESSON_BY_ID: ReadonlyMap<string, Lesson> = new Map(LESSONS.map((l) => [l.id, l]));

/** The six polished lessons, in curriculum order. The playable set. */
export const POLISHED_LESSON_IDS: readonly string[] = ${j(
  lessons.lessons.filter((l) => l.status === 'polished').map((l) => l.id),
)};

/**
 * The conceptual modules that DO carry firmware symbols.
 *
 * Kept as data so a test can pin them by name: they are the reason the badge
 * reads \`grounding\` and not \`symbols.length\` (L4 §6.3).
 */
export const CONCEPTUAL_LESSONS_WITH_SYMBOLS: readonly string[] = ${j(conceptualWithSymbols)};
`;

const previous = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
if (CHECK) {
  if (previous === out) {
    console.log(`OK    ${path.relative(REPO, OUT)} is up to date (${lessons.lessons.length} lessons)`);
    process.exit(0);
  }
  fail(
    `${path.relative(REPO, OUT)} is stale. Regenerate with:\n` +
      `  node apps/web/scripts/build-lessons-module.mjs`,
  );
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(
  `wrote ${path.relative(REPO, OUT)} — ${lessons.lessons.length} lessons, ` +
    `${lessons.coverage.steps.total} steps, ${v.checkTypes.length} check types, ` +
    `${bootOrder.length} boot steps`,
);
