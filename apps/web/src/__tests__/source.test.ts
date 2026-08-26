/**
 * The source explorer's data layer, held against `hardware/source-annotations.json`.
 *
 * Same posture as `architecture.test.ts`: the generated module is not trusted
 * because a script wrote it. Everything below re-reads the artefact from disk
 * and checks the projection, the joins and the integrity gate independently.
 *
 * The parts that need a browser — a rendered line number, a refusal banner —
 * are asserted in a real browser by `scripts/capture-web-screenshots.mjs`
 * phase 8, not in a DOM emulator.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { JOINT_ORDER } from '@sesame-lab/sesame-model';

import { ARCH_NODES, UPSTREAM_COMMIT } from '../generated/architecture-graph.js';
import {
  CURRICULUM,
  SOURCE_CONCEPTS,
  SOURCE_FILES,
  SOURCE_SYMBOLS,
  TEACHING_NOTES,
} from '../generated/source-annotations.js';
import { CPP_INITIAL_STATE, highlightCppLines, scanStateAt } from '../source/cpp-highlight.js';
import { loadPinnedSource, splitPinnedLines } from '../source/load.js';
import {
  archNodesInSymbol,
  citationsForSymbol,
  CONCEPTUAL_MODULES,
  rankConceptSymbols,
  symbolAt,
  symbolsCommanding,
  symbolsInFile,
  SYMBOL_BY_ID,
} from '../source/model.js';
import { sha256Hex } from '../source/sha256.js';
import { selectJoint, selectNode, selectSymbol } from '../state/selection.js';
import { rowMatchesSelection, type TraceRow } from '../state/trace-store.js';
import { serveUpstreamSource } from '../../vite.config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RAW = JSON.parse(
  fs.readFileSync(path.join(REPO, 'hardware/source-annotations.json'), 'utf8'),
) as {
  meta: { upstreamCommit: string; filesAnnotated: { file: string; lines: number; sha256: string }[] };
  symbols: { id: string; file: string; startLine: number; endLine: number; robotParts: string[] }[];
  concepts: { id: string; symbols: string[] }[];
  curriculum: { id: string; grounding: string; symbols: string[]; conceptualReason: string | null }[];
};

// ===========================================================================
describe('the projection matches the artefact', () => {
  it('carries every symbol, concept, note and module', () => {
    expect(SOURCE_SYMBOLS).toHaveLength(RAW.symbols.length);
    expect(SOURCE_CONCEPTS).toHaveLength(RAW.concepts.length);
    expect(TEACHING_NOTES).toHaveLength(17);
    expect(CURRICULUM).toHaveLength(RAW.curriculum.length);
  });

  it('pins the same upstream commit as the architecture graph', () => {
    expect(RAW.meta.upstreamCommit).toBe(UPSTREAM_COMMIT);
  });

  it('records a usable sha256 and line count for all four files', () => {
    expect(SOURCE_FILES).toHaveLength(4);
    for (const file of SOURCE_FILES) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.lines).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
describe('sha256 — the integrity gate', () => {
  it('agrees with node:crypto on the NIST vector', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('agrees with node:crypto across block boundaries', () => {
    // 55/56/57 and 63/64/65 are where the padding rules change.
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('hashes the pinned tree to what the annotations recorded', () => {
    // Skipped rather than failed on a clean clone: `firmware/upstream/` is
    // fetched by script and gitignored. When it IS present, drifting it must
    // fail here as well as in the browser.
    for (const file of SOURCE_FILES) {
      const onDisk = path.join(REPO, 'firmware/upstream', file.file);
      if (!fs.existsSync(onDisk)) continue;
      const bytes = fs.readFileSync(onDisk);
      expect(sha256Hex(new Uint8Array(bytes))).toBe(file.sha256);
      expect(splitPinnedLines(bytes.toString('utf8'))).toHaveLength(file.lines);
    }
  });

  it('drops the trailing newline rather than inventing a line', () => {
    expect(splitPinnedLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitPinnedLines('a\nb')).toEqual(['a', 'b']);
    expect(splitPinnedLines('')).toEqual([]);
    // The pinned tree is CRLF upstream: the hash is over the bytes as
    // received, the TEXT is compared with the CR stripped, because that is
    // how the annotations recorded `startLineText`.
    expect(splitPinnedLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    // ...and trailing whitespace, because L3 records the citation texts that
    // way. 11 of the 261 citations differ from the raw line by exactly this.
    expect(splitPinnedLines('  int x;  \r\n')).toEqual(['  int x;']);
  });
});

// ===========================================================================
describe('loadPinnedSource refuses a tree it cannot vouch for', () => {
  const file = SOURCE_FILES[1]?.file ?? 'firmware/movement-sequences.h';
  const facts = SOURCE_FILES[1];

  const fakeFetch = (body: Uint8Array | null, status = 200): typeof fetch =>
    (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        arrayBuffer: async () =>
          Promise.resolve((body ?? new Uint8Array(0)).buffer as ArrayBuffer),
      }) as unknown as Response) as unknown as typeof fetch;

  it('reports `missing` on a 404 — the clean-clone case', async () => {
    const result = await loadPinnedSource(file, fakeFetch(null, 404));
    expect(result.status).toBe('missing');
  });

  it('reports `mismatch` on the wrong bytes, with both hashes', async () => {
    const body = new TextEncoder().encode('// not the pinned tree\n');
    const result = await loadPinnedSource(file, fakeFetch(body));
    expect(result.status).toBe('mismatch');
    if (result.status !== 'mismatch') throw new Error('unreachable');
    expect(result.expectedSha256).toBe(facts?.sha256);
    expect(result.actualSha256).toBe(sha256Hex(body));
    expect(result.actualSha256).not.toBe(result.expectedSha256);
    // The line count is reported separately: "someone edited a line" and "this
    // is a different file" are different problems with different fixes.
    expect(result.expectedLines).toBe(facts?.lines);
    expect(result.actualLines).toBe(1);
  });

  it('reports `mismatch` when one byte of the real file changes', async () => {
    const onDisk = path.join(REPO, 'firmware/upstream', file);
    if (!fs.existsSync(onDisk)) return;
    const bytes = new Uint8Array(fs.readFileSync(onDisk));
    // A comment character deep in the file: same length, same line count, and
    // a different tree. This is the failure the line count alone cannot catch.
    const tampered = bytes.slice();
    tampered[Math.floor(tampered.length / 2)] = 0x21;
    const result = await loadPinnedSource(file, fakeFetch(tampered));
    expect(result.status).toBe('mismatch');
    if (result.status !== 'mismatch') throw new Error('unreachable');
    expect(result.actualLines).toBe(result.expectedLines);
  });

  it('accepts the real file unchanged', async () => {
    const onDisk = path.join(REPO, 'firmware/upstream', file);
    if (!fs.existsSync(onDisk)) return;
    const bytes = new Uint8Array(fs.readFileSync(onDisk));
    const result = await loadPinnedSource(file, fakeFetch(bytes));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.lines).toHaveLength(facts?.lines ?? 0);
    // The line numbering the whole pane rests on: `lines[n - 1]` IS line n,
    // and its text is EXACTLY what the annotation recorded — for all 90
    // symbols of this file, not for a sample.
    for (const symbol of symbolsInFile(file)) {
      expect(result.lines[symbol.startLine - 1]).toBe(symbol.startLineText);
      expect(result.lines[symbol.endLine - 1]).toBe(symbol.endLineText);
    }
    // Same for every teaching-note citation that lands in this file.
    for (const note of TEACHING_NOTES) {
      for (const evidence of note.evidence) {
        if (evidence.file !== file) continue;
        expect(result.lines[evidence.line - 1]).toBe(evidence.text);
      }
    }
  });
});

// ===========================================================================
describe('the node <-> symbol join is line containment', () => {
  it('lands every architecture node inside an annotated symbol', () => {
    const misses = ARCH_NODES.filter(
      (node) => node.sourceRef !== null && symbolAt(node.sourceRef.file, node.sourceRef.line) === null,
    );
    expect(misses.map((n) => n.id)).toEqual([]);
    expect(ARCH_NODES.filter((n) => n.sourceRef !== null)).toHaveLength(63);
  });

  it('resolves a nested range to the innermost span', () => {
    // `serial-cli` (:786-883) sits inside `loop` (:752-884). A line in both
    // belongs to the more specific one.
    const inner = symbolAt('firmware/sesame-firmware-main.ino', 800);
    expect(inner?.id).toBe('serial-cli');
    const outer = symbolAt('firmware/sesame-firmware-main.ino', 760);
    expect(outer?.id).toBe('loop');
  });

  it('returns null on an uncovered line rather than guessing', () => {
    // Line 1 of every file is a comment or `#pragma once`; L3 covers no such
    // line, by design.
    const covered = SOURCE_SYMBOLS.filter((s) => s.file === 'firmware/movement-sequences.h');
    const first = Math.min(...covered.map((s) => s.startLine));
    expect(first).toBeGreaterThan(1);
    expect(symbolAt('firmware/movement-sequences.h', 1)).toBeNull();
  });

  it('collects every node whose citation lands in one span', () => {
    // The eight joints plus `servos` all cite lines of the `ServoName` enum.
    const nodes = archNodesInSymbol('ServoName').map((n) => n.id);
    for (const joint of JOINT_ORDER) expect(nodes).toContain(`joint.${joint}`);
  });
});

// ===========================================================================
describe('one selection, four panes', () => {
  it('adds exactly one origin and keeps the model unforked', () => {
    expect(selectNode('joint.R4', 'source').origin).toBe('source');
  });

  it('takes every joint to a symbol whose robotParts contains it', () => {
    for (const joint of JOINT_ORDER) {
      const selection = selectJoint(joint, 'scene');
      expect(selection.symbolId).not.toBeNull();
      const symbol = SYMBOL_BY_ID.get(selection.symbolId ?? '');
      expect(symbol).toBeDefined();
      expect(symbol?.robotParts).toContain(joint);
    }
  });

  it('takes a symbol to its architecture node when the citation is unambiguous', () => {
    const selection = selectSymbol('runWavePose', 'source');
    expect(selection.symbolId).toBe('runWavePose');
    expect(selection.nodeId).toBe('movement.runWavePose');
  });

  it('refuses to guess when several nodes cite one span', () => {
    const selection = selectSymbol('ServoName', 'source');
    expect(selection.symbolId).toBe('ServoName');
    expect(selection.nodeId).toBeNull();
    expect(archNodesInSymbol('ServoName').length).toBeGreaterThan(1);
  });

  it('ignores an unknown symbol id instead of holding a dangling one', () => {
    expect(selectSymbol('not-a-symbol', 'source').symbolId).toBeNull();
  });

  it('matches trace rows by line containment', () => {
    const rowAt = (line: number): TraceRow =>
      ({
        id: `r${String(line)}`,
        // A layer no architecture node claims, so only the line-containment
        // branch can produce a match and the assertion is about that branch.
        layer: 'ui.command',
        joint: null,
        nodeId: null,
        sourceRef: { file: 'firmware/movement-sequences.h', line },
      }) as unknown as TraceRow;

    // 95 is inside runWavePose (91-107); 82 is inside runStandPose (77-89).
    expect(rowMatchesSelection(rowAt(95), selectSymbol('runWavePose', 'source'))).toBe(true);
    expect(rowMatchesSelection(rowAt(82), selectSymbol('runWavePose', 'source'))).toBe(false);
    // A joint selection resolves to `ServoName`, which names all eight. The
    // symbol branch must not fire there or one leg's click lights all of them.
    const enumLine = { ...rowAt(10) } as TraceRow;
    expect(rowMatchesSelection(enumLine, selectJoint('L3', 'scene'))).toBe(false);
  });
});

// ===========================================================================
describe('"which line moved this leg?"', () => {
  it('ranks the most specific span first', () => {
    const ranked = symbolsCommanding('R1');
    expect(ranked.length).toBeGreaterThan(20);
    // `runWavePose` commands four joints; `runStandPose` commands eight.
    const wave = ranked.findIndex((s) => s.id === 'runWavePose');
    const stand = ranked.findIndex((s) => s.id === 'runStandPose');
    expect(wave).toBeGreaterThanOrEqual(0);
    expect(wave).toBeLessThan(stand);
  });

  it('never re-sorts firmware enum order', () => {
    const wave = SYMBOL_BY_ID.get('runWavePose');
    expect(wave?.robotParts).toEqual(['R1', 'L2', 'R4', 'L3']);
  });
});

// ===========================================================================
describe('citations are made visible', () => {
  it('marks the symbol anchors and the teaching-note evidence', () => {
    const symbol = SYMBOL_BY_ID.get('setServoAngle');
    expect(symbol).toBeDefined();
    if (symbol === undefined) return;
    const citations = citationsForSymbol(symbol);
    expect(citations.get(symbol.startLine)?.some((c) => c.kind === 'symbol-start')).toBe(true);
    expect(citations.get(symbol.endLine)?.some((c) => c.kind === 'symbol-end')).toBe(true);
    // TN-007 cites :1054 inside setServoAngle.
    const tn007 = TEACHING_NOTES.find((n) => n.id === 'TN-007');
    const inside = (tn007?.evidence ?? []).filter(
      (e) => e.file === symbol.file && e.line >= symbol.startLine && e.line <= symbol.endLine,
    );
    expect(inside.length).toBeGreaterThan(0);
    for (const evidence of inside) {
      expect(citations.get(evidence.line)?.some((c) => c.targetId === 'TN-007')).toBe(true);
    }
  });

  it('keeps every citation inside the symbol it belongs to', () => {
    for (const symbol of SOURCE_SYMBOLS) {
      for (const line of citationsForSymbol(symbol).keys()) {
        expect(line).toBeGreaterThanOrEqual(symbol.startLine);
        expect(line).toBeLessThanOrEqual(symbol.endLine);
      }
    }
  });
});

// ===========================================================================
describe('concept density is capped, not drawn', () => {
  it('agrees with the artefact on how dense the worst concepts are', () => {
    const face = RAW.concepts.find((c) => c.id === 'face');
    expect(face?.symbols).toHaveLength(38);
    expect(rankConceptSymbols('face')).toHaveLength(38);
    expect(rankConceptSymbols('timing')).toHaveLength(33);
  });

  it('puts the primary anchor first and a 3141-line data block last-ish', () => {
    const ranked = rankConceptSymbols('face');
    expect(ranked[0]?.isAnchor).toBe(true);
    const blob = ranked.findIndex((r) => r.symbol.lineCount > 1000);
    const setFace = ranked.findIndex((r) => r.symbol.id === 'setFace');
    expect(setFace).toBeGreaterThanOrEqual(0);
    expect(blob).toBeGreaterThan(setFace);
  });

  it('is stable — the same input gives the same order', () => {
    const a = rankConceptSymbols('timing').map((r) => r.symbol.id);
    const b = rankConceptSymbols('timing').map((r) => r.symbol.id);
    expect(a).toEqual(b);
  });

  it('reports the one concept with no symbols rather than force-fitting it', () => {
    expect(rankConceptSymbols('emulator')).toHaveLength(0);
    const withoutSymbols = SOURCE_CONCEPTS.filter((c) => c.symbols.length === 0).map((c) => c.id);
    expect(withoutSymbols).toEqual(['emulator']);
  });

  it('carries all three explanatory levels on every concept', () => {
    for (const concept of SOURCE_CONCEPTS) {
      expect(concept.levels.beginner12.length).toBeGreaterThan(0);
      expect(concept.levels.beginnerProgrammer.length).toBeGreaterThan(0);
      expect(concept.levels.architecture.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
describe('Gate F at the UI layer', () => {
  it('finds exactly seven conceptual modules, each with a stated reason', () => {
    expect(CONCEPTUAL_MODULES).toHaveLength(7);
    for (const module of CONCEPTUAL_MODULES) {
      expect(module.conceptualReason).not.toBeNull();
      expect(module.conceptualReason?.length ?? 0).toBeGreaterThan(20);
    }
    // Three of the seven DO reference symbols — `inside-the-brain` cites the
    // pin table, `build-a-leg-pose` cites two pose functions. That is not a
    // contradiction: the pins and the pose vectors are facts, and it is the
    // module's FRAMING (a chip interior, an anatomy) that has no firmware
    // grounding. The badge is therefore driven by `grounding`, never by
    // whether `symbols[]` happens to be empty.
    const withSymbols = CONCEPTUAL_MODULES.filter((m) => m.symbols.length > 0).map((m) => m.id);
    expect(withSymbols).toEqual(['inside-the-brain', 'build-a-leg-pose', 'build-a-movement']);
  });

  it('backs every factual module with at least one real symbol', () => {
    for (const module of CURRICULUM.filter((m) => m.grounding === 'factual')) {
      expect(module.symbols.length).toBeGreaterThan(0);
      for (const id of module.symbols) expect(SYMBOL_BY_ID.has(id)).toBe(true);
    }
  });
});

// ===========================================================================
describe('teaching material keeps its three registers apart', () => {
  it('puts library evidence only where the evidence is a library', () => {
    const withLibrary = TEACHING_NOTES.filter((n) => n.libraryEvidence !== null).map((n) => n.id);
    expect(withLibrary).toEqual(['TN-006', 'TN-007']);
    for (const note of TEACHING_NOTES) {
      if (note.libraryEvidence === null) continue;
      expect(note.libraryEvidence.library).toBe('ESP32Servo');
      expect(note.libraryEvidence.version).toBe('3.0.9');
      // Not shaped like a firmware citation: it must not resolve against the
      // pinned tree, and nothing may try.
      expect(SOURCE_FILES.map((f) => f.file)).not.toContain(note.libraryEvidence.file);
    }
  });

  it('requires a defect to cite an issue', () => {
    for (const note of TEACHING_NOTES.filter((n) => n.kind === 'defect')) {
      expect(note.references.join(' ')).toMatch(/ISSUE-/);
    }
  });

  it('never claims a servo did anything', () => {
    const forbidden = /\b(the servo moved|observed at the pin|we measured on hardware|actually rotat)/i;
    for (const symbol of SOURCE_SYMBOLS) {
      expect(symbol.description).not.toMatch(forbidden);
      if (symbol.commentary !== null) expect(symbol.commentary).not.toMatch(forbidden);
    }
    for (const note of TEACHING_NOTES) expect(note.summary).not.toMatch(forbidden);
  });
});

// ===========================================================================
describe('C++ colouring is a scanner, and knows it spans lines', () => {
  it('keeps a raw string literal a string across line breaks', () => {
    const lines = [
      'const char index_html[] PROGMEM = R"rawliteral(',
      '<html><script>for (var i = 0; i < 10; i++) {}</script>',
      ')rawliteral";',
    ];
    const out = highlightCppLines(lines, CPP_INITIAL_STATE);
    // The middle line contains `for`, `var` and `int`-ish text; none of it may
    // be coloured as C++.
    expect(out[1]?.every((token) => token.kind === 'string')).toBe(true);
  });

  it('keeps a block comment a comment across line breaks', () => {
    const out = highlightCppLines(['/* start', 'return 3;', 'end */ int x;']);
    expect(out[1]?.every((token) => token.kind === 'comment')).toBe(true);
    expect(out[2]?.some((token) => token.kind === 'type' && token.text === 'int')).toBe(true);
  });

  it('recovers the scanner state for a window that starts mid-file', () => {
    const all = ['R"raw(', 'a', 'b', ')raw";'];
    expect(scanStateAt(all, 3).rawDelimiter).toBe('raw');
    expect(scanStateAt(all, 1)).toEqual(CPP_INITIAL_STATE);
  });

  it('treats a preprocessor line as one directive', () => {
    const out = highlightCppLines(['#include <Arduino.h>']);
    expect(out[0]).toEqual([{ kind: 'preproc', text: '#include <Arduino.h>' }]);
  });
});

// ===========================================================================
describe('the build refuses to bundle a tree the annotations do not describe', () => {
  /**
   * Drive the Vite plugin's `generateBundle` directly against a scratch tree.
   *
   * `firmware/upstream/` is read-only to this task and to every other agent in
   * this repository, so `SESAME_UPSTREAM_DIR` exists precisely so this branch
   * can be exercised without touching it.
   */
  const withScratchTree = async (
    mutate: (dir: string) => void,
  ): Promise<{ errors: string[]; warnings: string[]; emitted: string[] }> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesame-upstream-'));
    try {
      for (const file of SOURCE_FILES) {
        const from = path.join(REPO, 'firmware/upstream', file.file);
        if (!fs.existsSync(from)) return { errors: [], warnings: [], emitted: [] };
        const to = path.join(dir, file.file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      mutate(dir);

      const previous = process.env.SESAME_UPSTREAM_DIR;
      process.env.SESAME_UPSTREAM_DIR = dir;
      const plugin = serveUpstreamSource();
      process.env.SESAME_UPSTREAM_DIR = previous;

      const errors: string[] = [];
      const warnings: string[] = [];
      const emitted: string[] = [];
      const context = {
        error: (message: string) => {
          errors.push(message);
          throw new Error(message);
        },
        warn: (message: string) => warnings.push(message),
        emitFile: (asset: { fileName?: string }) => emitted.push(asset.fileName ?? ''),
      };
      const generate = plugin.generateBundle;
      const run = typeof generate === 'function' ? generate : generate?.handler;
      try {
        await (run as (this: unknown, ...args: unknown[]) => unknown).call(context, {}, {}, false);
      } catch {
        /* `this.error()` throws by contract; the message is already captured */
      }
      return { errors, warnings, emitted };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('emits all four files from an untouched tree', async () => {
    const result = await withScratchTree(() => undefined);
    if (result.emitted.length === 0 && result.errors.length === 0) return; // clean clone
    expect(result.errors).toEqual([]);
    expect(result.emitted.sort()).toEqual(
      SOURCE_FILES.map((f) => `upstream/${f.file}`).sort(),
    );
  });

  it('fails the build when one byte differs, and names both hashes', async () => {
    const target = SOURCE_FILES[1]?.file ?? 'firmware/movement-sequences.h';
    const result = await withScratchTree((dir) => {
      const victim = path.join(dir, target);
      const bytes = fs.readFileSync(victim);
      bytes[Math.floor(bytes.length / 2)] = 0x21;
      fs.writeFileSync(victim, bytes);
    });
    if (result.errors.length === 0 && result.emitted.length === 0) return; // clean clone
    expect(result.errors).toHaveLength(1);
    // It stopped at the offending file rather than emitting it.
    expect(result.emitted).not.toContain(`upstream/${target}`);
    expect(result.errors[0]).toContain(target);
    expect(result.errors[0]).toContain(SOURCE_FILES[1]?.sha256 ?? '');
    expect(result.errors[0]).toMatch(/fetch-upstream/);
  });

  it('warns rather than failing when the tree has not been fetched', async () => {
    const result = await withScratchTree((dir) => {
      for (const file of SOURCE_FILES) fs.rmSync(path.join(dir, file.file), { force: true });
    });
    expect(result.errors).toEqual([]);
    expect(result.emitted).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/fetch-upstream/);
  });
});
