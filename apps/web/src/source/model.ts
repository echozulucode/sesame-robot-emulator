/**
 * The joins that make the four panes one thing.
 *
 * ```text
 * Real source  <->  Architecture node  <->  Robot part  <->  Runtime event
 * ```
 *
 * Every edge in that diagram is computed here, from data, at runtime. Nothing
 * below is a hand-maintained mapping table, because a hand-maintained mapping
 * table between two generated artefacts is a third artefact that can drift from
 * both.
 *
 * ## The join is line containment, not name matching
 *
 * V8 measured it: **all 63 architecture nodes' `sourceRef` fall inside an
 * annotated symbol, zero misses.** So `node -> symbol` is
 * "which `[startLine, endLine]` contains `sourceRef.line`", and it needs no new
 * key on either side.
 *
 * The other available route — `symbol.crossRefs.hardwareMap[]` against
 * `ArchNode.derivedFrom` — is deliberately *not* used. The two spell the same
 * JSON paths differently (`network.http.routes[/].bodySource` against
 * `network.http.routes[5]`), and normalising one to the other in here would
 * quietly manufacture agreement. {@link derivedFromAgreement} surfaces the
 * disagreement instead, where a reader can see it.
 *
 * ## Two things a caller must not assume
 *
 * 1. **A `sourceRef` is a citation, not a definition.** Several nodes cite a
 *    call site or a registration line, because that is what `hardware-map.json`
 *    cites. The containing symbol is "the code this line is in", which is the
 *    right reading unit, but it is not "the thing this node is named after".
 * 2. **Containment can be ambiguous, and the innermost span wins.** L3 permits
 *    nesting: `serial-cli` (`:786-883`) sits inside `loop` (`:752-884`). Two
 *    nodes — `developer` and `serial.cli` — land in both. The innermost is the
 *    more specific reading unit and is the one a learner asked for.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';

import { ARCH_NODES, ARCH_NODE_BY_ID, type ArchNode } from '../generated/architecture-graph.js';
import {
  CURRICULUM,
  SOURCE_CONCEPTS,
  SOURCE_FILES,
  SOURCE_SYMBOLS,
  TEACHING_NOTES,
  type CurriculumModule,
  type SourceConcept,
  type SourceFileName,
  type SourceSymbol,
  type TeachingNote,
} from '../generated/source-annotations.js';

// ------------------------------------------------------------------ indices

export const SYMBOL_BY_ID: ReadonlyMap<string, SourceSymbol> = new Map(
  SOURCE_SYMBOLS.map((s) => [s.id, s]),
);
export const CONCEPT_BY_ID: ReadonlyMap<string, SourceConcept> = new Map(
  SOURCE_CONCEPTS.map((c) => [c.id, c]),
);
export const NOTE_BY_ID: ReadonlyMap<string, TeachingNote> = new Map(
  TEACHING_NOTES.map((n) => [n.id, n]),
);
export const MODULE_BY_ID: ReadonlyMap<string, CurriculumModule> = new Map(
  CURRICULUM.map((m) => [m.id, m]),
);

/** The four files, in the order L3 lists them. */
export const SOURCE_FILE_NAMES: readonly SourceFileName[] = SOURCE_FILES.map((f) => f.file);

export const FILE_FACTS = new Map(SOURCE_FILES.map((f) => [f.file, f]));

/** Symbols of one file, in reading order. This is the outline. */
export function symbolsInFile(file: SourceFileName): readonly SourceSymbol[] {
  return SOURCE_SYMBOLS.filter((s) => s.file === file).sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
}

// -------------------------------------------------------- source <-> source

const spans = (s: SourceSymbol): number => s.endLine - s.startLine;

/**
 * The innermost annotated symbol containing `file:line`, or `null`.
 *
 * `null` is a real answer: L3 covers 91–99 % of lines and every uncovered line
 * is blank, a comment, a `#pragma once` or an `#include`. A caller that treats
 * `null` as an error will fire on the include block.
 */
export function symbolAt(file: string, line: number): SourceSymbol | null {
  let best: SourceSymbol | null = null;
  for (const symbol of SOURCE_SYMBOLS) {
    if (symbol.file !== file) continue;
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (best === null || spans(symbol) < spans(best)) best = symbol;
  }
  return best;
}

/** Does `file:line` fall inside this symbol? The trace-row join. */
export function symbolContains(symbol: SourceSymbol, file: string, line: number): boolean {
  return symbol.file === file && line >= symbol.startLine && line <= symbol.endLine;
}

// ------------------------------------------------- source <-> architecture

/** The symbol an architecture node's `sourceRef` sits in. */
export function symbolForNode(nodeId: string | null): SourceSymbol | null {
  if (nodeId === null) return null;
  const node = ARCH_NODE_BY_ID.get(nodeId);
  if (node?.sourceRef == null) return null;
  return symbolAt(node.sourceRef.file, node.sourceRef.line);
}

/**
 * Every architecture node whose `sourceRef` lands inside this symbol.
 *
 * Usually one. `ServoName` (`movement-sequences.h:5-14`) attracts nine — the
 * eight joint nodes plus `servos` — because `hardware-map.json` cites the enum
 * line for each joint. That is not a defect: it is what "where is R4 in the
 * source?" honestly answers, and the UI shows all of them rather than picking.
 */
export function archNodesInSymbol(symbolId: string | null): readonly ArchNode[] {
  const symbol = symbolId === null ? null : SYMBOL_BY_ID.get(symbolId);
  if (symbol === undefined || symbol === null) return [];
  return ARCH_NODES.filter(
    (n) => n.sourceRef !== null && symbolContains(symbol, n.sourceRef.file, n.sourceRef.line),
  );
}

/**
 * Whether the two independent routes from node to symbol agree on provenance.
 *
 * V8 warned that L3 spells route paths by key and the graph generator spells
 * them by index. Rather than normalise one into the other — which would
 * manufacture agreement — this reports what each side says and lets the pane
 * show both. A disagreement is a fact worth seeing.
 */
export function derivedFromAgreement(
  node: ArchNode,
  symbol: SourceSymbol,
): { readonly agrees: boolean; readonly nodeSays: string; readonly symbolSays: readonly string[] } {
  const symbolSays = symbol.crossRefs.hardwareMap ?? [];
  return { agrees: symbolSays.includes(node.derivedFrom), nodeSays: node.derivedFrom, symbolSays };
}

// -------------------------------------------------- source <-> robot part

const isJoint = (value: string): value is JointName =>
  (JOINT_ORDER as readonly string[]).includes(value);

/** A symbol's `robotParts`, filtered to real joint names. Order is preserved. */
export function jointsOf(symbol: SourceSymbol): readonly JointName[] {
  return symbol.robotParts.filter(isJoint);
}

/**
 * Code that commands this joint, most specific first.
 *
 * 26 symbols name `R1`, so an unranked list is a wall. Ranking:
 *
 * 1. **fewer `robotParts` first** — `runWavePose` commands four joints and
 *    `runStandPose` commands eight, so the wave says more about R1 than the
 *    stand does;
 * 2. **shorter span first** — a tighter span is a more precise answer;
 * 3. file then start line, so the order is stable and reproducible.
 *
 * Joint order inside `robotParts` is firmware enum order and is never re-sorted
 * anywhere in here.
 */
export function symbolsCommanding(joint: JointName): readonly SourceSymbol[] {
  return SOURCE_SYMBOLS.filter((s) => s.robotParts.includes(joint)).sort((a, b) => {
    if (a.robotParts.length !== b.robotParts.length) return a.robotParts.length - b.robotParts.length;
    if (a.lineCount !== b.lineCount) return a.lineCount - b.lineCount;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.startLine - b.startLine;
  });
}

// ------------------------------------------------------------- citations

export type CitationKind =
  | 'symbol-start'
  | 'symbol-end'
  | 'teaching-note'
  | 'concept-anchor'
  | 'architecture';

export interface LineCitation {
  readonly line: number;
  readonly kind: CitationKind;
  /** Who cites it, in the form the UI shows. */
  readonly label: string;
  /** The cited line's text as the annotation recorded it, when it recorded one. */
  readonly text: string | null;
  /** For `teaching-note` / `concept-anchor` / `architecture`: the id to select. */
  readonly targetId: string | null;
}

/**
 * Every line inside `symbol` that some artefact in this repository cites.
 *
 * These are the lines the source pane marks in the gutter. L3's whole integrity
 * story rests on them — each carries the exact text of the line it points at,
 * and the validator re-reads the pinned tree and compares. Making them visible
 * is what turns "trust the annotations" into "here is the line, and here is
 * what claims it".
 */
export function citationsForSymbol(symbol: SourceSymbol): ReadonlyMap<number, LineCitation[]> {
  const out = new Map<number, LineCitation[]>();
  const add = (citation: LineCitation): void => {
    const list = out.get(citation.line);
    if (list === undefined) out.set(citation.line, [citation]);
    else list.push(citation);
  };

  add({
    line: symbol.startLine,
    kind: 'symbol-start',
    label: `${symbol.id} starts here`,
    text: symbol.startLineText,
    targetId: symbol.id,
  });
  if (symbol.endLine !== symbol.startLine) {
    add({
      line: symbol.endLine,
      kind: 'symbol-end',
      label: `${symbol.id} ends here`,
      text: symbol.endLineText,
      targetId: symbol.id,
    });
  }

  for (const note of TEACHING_NOTES) {
    for (const evidence of note.evidence) {
      if (!symbolContains(symbol, evidence.file, evidence.line)) continue;
      add({
        line: evidence.line,
        kind: 'teaching-note',
        label: `${note.id} — ${note.title}`,
        text: evidence.text,
        targetId: note.id,
      });
    }
  }

  for (const concept of SOURCE_CONCEPTS) {
    const anchor = concept.primaryAnchor;
    if (anchor === null) continue;
    if (!symbolContains(symbol, anchor.file, anchor.line)) continue;
    add({
      line: anchor.line,
      kind: 'concept-anchor',
      label: `concept “${concept.label}” anchors here`,
      text: anchor.text,
      targetId: concept.id,
    });
  }

  for (const node of ARCH_NODES) {
    if (node.sourceRef === null) continue;
    if (!symbolContains(symbol, node.sourceRef.file, node.sourceRef.line)) continue;
    add({
      line: node.sourceRef.line,
      kind: 'architecture',
      label: `architecture node ${node.id} cites this line`,
      text: null,
      targetId: node.id,
    });
  }

  return out;
}

// -------------------------------------------------------- concept density

export interface RankedConceptSymbol {
  readonly symbol: SourceSymbol;
  readonly score: number;
  readonly isAnchor: boolean;
}

/**
 * A concept's symbols, ranked, so the panel can cap instead of hairballing.
 *
 * L3 warns that `concepts[].symbols` is dense — `face` 38, `timing` 33,
 * `animation` 33 of 90 symbols. Drawing that as a graph produces a hairball
 * that teaches nothing; listing all 38 alphabetically is a wall. So the panel
 * shows a ranked list, capped, with the rest one click away.
 *
 * Three terms, all derived from data already present:
 *
 * - **anchor** (+2): L3 chose one symbol as the concept's `primaryAnchor`. That
 *   is an explicit editorial judgement about which code best shows the concept,
 *   and it should lead.
 * - **centrality** (0…1): where this concept sits in the symbol's own
 *   `concepts[]` list. A symbol that lists `timing` first is more about timing
 *   than one that lists it fifth.
 * - **specificity** (0…1): `1 / log2(lineCount + 2)`. `face-bitmaps.h`'s
 *   3141-line data block genuinely does concern `face`, and it teaches a
 *   learner far less about it than the 12-line `setFace()` does.
 *
 * Ties break on file then start line, so the order is stable across renders and
 * assertable in a test.
 */
export function rankConceptSymbols(conceptId: string): readonly RankedConceptSymbol[] {
  const concept = CONCEPT_BY_ID.get(conceptId);
  if (concept === undefined) return [];
  const anchorSymbol = concept.primaryAnchor?.symbol ?? null;

  return concept.symbols
    .map((id) => SYMBOL_BY_ID.get(id))
    .filter((s): s is SourceSymbol => s !== undefined)
    .map((symbol) => {
      const position = symbol.concepts.indexOf(conceptId);
      const centrality = position < 0 ? 0 : 1 / (1 + position);
      const specificity = 1 / Math.log2(symbol.lineCount + 2);
      const isAnchor = symbol.id === anchorSymbol;
      return {
        symbol,
        isAnchor,
        score: (isAnchor ? 2 : 0) + centrality + specificity,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.symbol.file !== b.symbol.file) return a.symbol.file < b.symbol.file ? -1 : 1;
      return a.symbol.startLine - b.symbol.startLine;
    });
}

/** How many symbols a concept claims. Drives the "38 symbols" density badge. */
export function conceptDensity(conceptId: string): number {
  return CONCEPT_BY_ID.get(conceptId)?.symbols.length ?? 0;
}

// ------------------------------------------------------------- curriculum

/**
 * Curriculum modules that reference this symbol or any of its concepts.
 *
 * `grounding` rides along untouched: 7 of the 19 modules have no backing
 * firmware symbol at all and the badge says so.
 */
export function modulesForSymbol(symbol: SourceSymbol): readonly CurriculumModule[] {
  const conceptSet = new Set(symbol.concepts);
  return CURRICULUM.filter(
    (m) => m.symbols.includes(symbol.id) || m.concepts.some((c) => conceptSet.has(c)),
  );
}

/** The 7 modules with `grounding: "conceptual"`. */
export const CONCEPTUAL_MODULES: readonly CurriculumModule[] = CURRICULUM.filter(
  (m) => m.grounding === 'conceptual',
);

// ------------------------------------------------------- teaching material

export function notesForSymbol(symbol: SourceSymbol): readonly TeachingNote[] {
  return symbol.teachingNotes
    .map((id) => NOTE_BY_ID.get(id))
    .filter((n): n is TeachingNote => n !== undefined);
}

export function conceptsForSymbol(symbol: SourceSymbol): readonly SourceConcept[] {
  return symbol.concepts
    .map((id) => CONCEPT_BY_ID.get(id))
    .filter((c): c is SourceConcept => c !== undefined);
}
