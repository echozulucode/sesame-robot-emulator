/**
 * The source explorer — the fourth pane, and the one that closes the loop.
 *
 * ```text
 * Real source  <->  Architecture node  <->  Robot part  <->  Runtime event
 * ```
 *
 * The research report calls those four synchronised panes the point of the
 * whole feature, and names the two questions they answer: *“which line moved
 * this leg?”* and *“what moved when this line ran?”*. Everything below serves
 * those two sentences.
 *
 * ## It does not own a selection
 *
 * Every click here goes through `selectSymbol()` / `selectNode()` /
 * `selectJoint()` in `state/selection.ts`, the same single object the 3D scene,
 * the graph and the trace read and write. That is why selecting `runWavePose`
 * lights `movement.wave` in the graph, lights R1/L2/R4/L3 in three.js, and
 * lights the trace rows whose `sourceRef` falls between lines 91 and 107 — with
 * no code in here reaching into another pane.
 *
 * ## It refuses to render source it has not verified
 *
 * `firmware/upstream/` is gitignored. `src/source/load.ts` hashes the bytes the
 * browser received against `meta.filesAnnotated[].sha256` before a single line
 * is drawn, and this component renders **no code at all** unless the answer is
 * `ok`. Source shown at the wrong line numbers looks completely correct and is
 * completely wrong, which is the one failure a learner cannot catch.
 *
 * ## Three registers, three treatments
 *
 * L3 separates what the code says from what we think about it, and the pane has
 * to keep that separation visible or the distinction is lost the moment it is
 * rendered:
 *
 * | Register | Source | Treatment |
 * |---|---|---|
 * | `description` | the pinned tree, checkable line by line | plain body text |
 * | `commentary` | a **judgement** by whoever wrote the annotation | amber aside, labelled, italic |
 * | `libraryEvidence` | ESP32Servo 3.0.9 — **a different tree** | violet block, versioned citation, no line link |
 *
 * A learner must always be able to tell “the code says this” from “we think
 * this is interesting” from “this comes from a library we did not pin”.
 */
import {
  SERVO_PULSE_QUANTISATION,
  SERVO_TIMER_WIDTH_TICKS,
  anglesIndistinguishableFrom,
  quantiseCommandedAngle,
  type JointName,
} from '@sesame-lab/sesame-model';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import {
  ANNOTATIONS_UPSTREAM_COMMIT,
  type ConceptLevels,
  type SourceConcept,
  type SourceFileName,
  type SourceSymbol,
  type TeachingNote,
} from '../generated/source-annotations.js';
import { highlightCppLines, scanStateAt, type CppToken } from '../source/cpp-highlight.js';
import { loadPinnedSource, type SourceLoad } from '../source/load.js';
import {
  archNodesInSymbol,
  citationsForSymbol,
  conceptsForSymbol,
  CONCEPT_BY_ID,
  derivedFromAgreement,
  FILE_FACTS,
  jointsOf,
  modulesForSymbol,
  notesForSymbol,
  rankConceptSymbols,
  SOURCE_FILE_NAMES,
  SYMBOL_BY_ID,
  symbolsCommanding,
  symbolsInFile,
  type LineCitation,
} from '../source/model.js';
import type { SelectionState } from '../state/selection.js';
import { rowMatchesSelection, type TraceRow } from '../state/trace-store.js';

export interface SourceExplorerProps {
  readonly selection: SelectionState;
  readonly onSelectSymbol: (symbolId: string | null) => void;
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly onSelectJoint: (joint: JointName | null) => void;
  /** The rows the trace pane is showing. The runtime-event half of the sync. */
  readonly traceRows: readonly TraceRow[];
  readonly onSelectRow: (row: TraceRow) => void;
}

/** Lines of context either side of the symbol. Enough to see the brace above. */
const CONTEXT_LINES = 8;

/**
 * Hard cap on rendered lines.
 *
 * `index_html` is a **1007-line** raw string literal and `face-bitmaps.h` is
 * 3158 lines of hex. Rendering either in full puts thousands of DOM nodes in
 * front of a SwiftShader render loop that needs every frame it can get. The cap
 * is announced in the UI rather than silently applied — a truncation the reader
 * cannot see is the same class of lie as a wrong line number.
 */
const MAX_RENDERED_LINES = 240;

/** How many ranked symbols a concept shows before paging. L3 warns `face` has 38. */
const CONCEPT_PAGE = 6;

type LevelKey = keyof ConceptLevels;

/** One line of pinned source: its real line number, and its coloured tokens. */
interface RenderedLine {
  readonly line: number;
  readonly tokens: readonly CppToken[];
}

const LEVELS: readonly { readonly key: LevelKey; readonly label: string }[] = [
  { key: 'beginner12', label: 'age ~12' },
  { key: 'beginnerProgrammer', label: 'new programmer' },
  { key: 'architecture', label: 'architecture' },
];

const KIND_MARK: Record<string, string> = {
  entrypoint: '▶',
  handler: '⇄',
  helper: 'ƒ',
  'pose-function': '⟟',
  'movement-function': '⟳',
  region: '▤',
  type: 'T',
  table: '☰',
  macro: '#',
  config: '⚙',
  state: '●',
  data: '▦',
};

const shortFile = (file: string): string => file.replace(/^firmware\//, '');

export function SourceExplorer(props: SourceExplorerProps): ReactElement {
  const { selection, onSelectSymbol, onSelectNode, onSelectJoint, traceRows, onSelectRow } = props;

  const symbol = selection.symbolId === null ? null : (SYMBOL_BY_ID.get(selection.symbolId) ?? null);

  const [file, setFile] = useState<SourceFileName>(
    () => SOURCE_FILE_NAMES[1] ?? (SOURCE_FILE_NAMES[0] as SourceFileName),
  );
  const [loads, setLoads] = useState<Partial<Record<SourceFileName, SourceLoad>>>({});
  const [level, setLevel] = useState<LevelKey>('beginnerProgrammer');
  const [focusConcept, setFocusConcept] = useState<string | null>(null);
  const [conceptPage, setConceptPage] = useState(0);
  const [probeDeg, setProbeDeg] = useState(90);
  const codeRef = useRef<HTMLDivElement | null>(null);

  // The file follows the selection — on a CHANGE of selection, not on every
  // render. Comparing `symbol.file` against `file` each time looks equivalent
  // and is not: it makes the file tabs unclickable, because the very next
  // render snaps back to whatever file the still-selected symbol lives in.
  const lastSymbolId = useRef<string | null>(null);
  useEffect(() => {
    if (symbol === null) return;
    if (lastSymbolId.current === symbol.id) return;
    lastSymbolId.current = symbol.id;
    setFile(symbol.file);
  }, [symbol]);

  // Lazily fetch and verify. 297 kB of `face-bitmaps.h` is not worth loading
  // until someone asks for it.
  //
  // The in-flight set is a ref, not state, and the effect depends on `file`
  // alone. Depending on `loads` instead looks tidier and deadlocks: writing the
  // `loading` placeholder re-runs the effect, whose cleanup then cancels the
  // fetch that placeholder was standing in for, and the pane hangs on
  // "hashing…" forever.
  const requested = useRef(new Set<SourceFileName>());
  useEffect(() => {
    if (requested.current.has(file)) return;
    requested.current.add(file);
    setLoads((previous) => ({ ...previous, [file]: { status: 'loading', file } }));
    void loadPinnedSource(file).then((result) => {
      setLoads((previous) => ({ ...previous, [file]: result }));
    });
  }, [file]);

  const load: SourceLoad = loads[file] ?? { status: 'loading', file };
  const facts = FILE_FACTS.get(file);
  const outline = useMemo(() => symbolsInFile(file), [file]);

  // ------------------------------------------------------------- the window
  const viewWindow = useMemo(() => {
    const total = facts?.lines ?? 0;
    if (symbol === null || symbol.file !== file) {
      return { from: 1, to: Math.min(total, MAX_RENDERED_LINES), clipped: total > MAX_RENDERED_LINES };
    }
    const from = Math.max(1, symbol.startLine - CONTEXT_LINES);
    const wanted = Math.min(total, symbol.endLine + CONTEXT_LINES);
    const to = Math.min(wanted, from + MAX_RENDERED_LINES - 1);
    return { from, to, clipped: to < wanted };
  }, [symbol, file, facts]);

  /**
   * The rendered lines, each carrying its own number.
   *
   * The number is computed HERE, beside the text it belongs to, rather than as
   * `viewWindow.from + index` at the point of drawing. That is not tidiness: a
   * stale dependency once let this memo hold the slice for one window while the
   * gutter numbered it for another, and the pane cheerfully drew `#pragma once`
   * as line 83. The whole credibility of this feature is that the number beside
   * a line is that line's number, so the two are now produced together and
   * cannot drift apart.
   */
  const rendered = useMemo(() => {
    if (load.status !== 'ok') return [] as readonly RenderedLine[];
    const slice = load.lines.slice(viewWindow.from - 1, viewWindow.to);
    const tokens = highlightCppLines(slice, scanStateAt(load.lines, viewWindow.from));
    return tokens.map((line, index) => ({ line: viewWindow.from + index, tokens: line }));
  }, [load, viewWindow]);

  const citations = useMemo(
    () => (symbol === null ? new Map<number, LineCitation[]>() : citationsForSymbol(symbol)),
    [symbol],
  );

  /** Trace rows whose `sourceRef` landed inside the rendered window. */
  const rowsByLine = useMemo(() => {
    const map = new Map<number, TraceRow[]>();
    for (const row of traceRows) {
      if (row.sourceRef === null || row.sourceRef.file !== file) continue;
      const list = map.get(row.sourceRef.line);
      if (list === undefined) map.set(row.sourceRef.line, [row]);
      else list.push(row);
    }
    return map;
  }, [traceRows, file]);

  const hitRows = useMemo(
    () => traceRows.filter((row) => rowMatchesSelection(row, selection)),
    [traceRows, selection],
  );

  // Scroll the symbol into view without scrolling any ancestor: `scrollIntoView`
  // would move the whole workbench column and take the architecture graph off
  // screen — and, in this app, any unasked-for scroll near the renderer is the
  // shape of ISSUE-20260823-023.
  //
  // Measured with `getBoundingClientRect`, not `offsetTop`: `offsetTop` is
  // relative to the nearest POSITIONED ancestor, which is not necessarily the
  // scroll container, and reading it as if it were lands the view a panel's
  // height away from the line it was asked for.
  useEffect(() => {
    const container = codeRef.current;
    if (container === null || symbol === null || load.status !== 'ok') return;
    const target = container.querySelector<HTMLElement>(`[data-line="${String(symbol.startLine)}"]`);
    if (target === null) return;
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop = Math.max(0, container.scrollTop + delta - container.clientHeight / 3);
  }, [symbol, load.status, viewWindow.from]);

  // The focused concept follows the selection unless the learner picked one.
  const concepts = symbol === null ? [] : conceptsForSymbol(symbol);
  const conceptId = focusConcept ?? concepts[0]?.id ?? null;
  const concept = conceptId === null ? null : (CONCEPT_BY_ID.get(conceptId) ?? null);

  return (
    <section className="panel source-panel" data-testid="source-explorer">
      <header className="panel-header">
        <h2>Source</h2>
        <span className="panel-sub">
          upstream <code>{ANNOTATIONS_UPSTREAM_COMMIT.slice(0, 7)}</code> · line numbers are the
          pinned tree&rsquo;s
        </span>
      </header>

      <div className="source-tabs" role="tablist">
        {SOURCE_FILE_NAMES.map((name) => {
          const state = loads[name]?.status ?? 'unloaded';
          return (
            <button
              key={name}
              type="button"
              role="tab"
              className={`source-tab${name === file ? ' active' : ''}`}
              data-source-file={name}
              data-load-status={state}
              aria-selected={name === file}
              onClick={() => setFile(name)}
            >
              {shortFile(name)}
              <span className="dim"> · {FILE_FACTS.get(name)?.lines ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div className="source-body">
        {/* ------------------------------------------------------- outline */}
        <nav className="source-outline" data-testid="source-outline">
          {outline.map((entry) => {
            const selected = entry.id === selection.symbolId;
            return (
              <button
                key={entry.id}
                type="button"
                className={`source-outline-row${selected ? ' is-selected' : ''}`}
                data-source-symbol={entry.id}
                data-selected={String(selected)}
                data-start-line={entry.startLine}
                data-end-line={entry.endLine}
                title={`${entry.signature} · ${entry.file}:${String(entry.startLine)}-${String(entry.endLine)}`}
                onClick={() => onSelectSymbol(selected ? null : entry.id)}
              >
                <span className="source-kind" data-kind={entry.kind}>
                  {KIND_MARK[entry.kind] ?? '·'}
                </span>
                <span className="source-outline-name">{entry.id}</span>
                <span className="source-outline-lines mono">{entry.startLine}</span>
              </button>
            );
          })}
        </nav>

        {/* ---------------------------------------------------------- code */}
        <div className="source-code-wrap">
          <SourceIntegrity load={load} />

          {load.status === 'ok' && (
            <>
              <div className="source-code" ref={codeRef} data-testid="source-code">
                {rendered.map(({ line, tokens }) => {
                  const inSymbol =
                    symbol !== null && line >= symbol.startLine && line <= symbol.endLine;
                  const cited = citations.get(line) ?? [];
                  const ran = rowsByLine.get(line) ?? [];
                  const classes = [
                    'src-line',
                    inSymbol ? 'in-symbol' : '',
                    cited.length > 0 ? 'is-cited' : '',
                    ran.length > 0 ? 'did-run' : '',
                  ]
                    .filter((c) => c.length > 0)
                    .join(' ');
                  return (
                    <div
                      key={line}
                      className={classes}
                      data-line={line}
                      data-in-symbol={String(inSymbol)}
                      data-cited={String(cited.length > 0)}
                      data-ran={String(ran.length > 0)}
                      title={
                        cited.length === 0
                          ? undefined
                          : cited.map((c) => c.label).join('\n')
                      }
                      onClick={() => {
                        const first = ran[0];
                        if (first !== undefined) onSelectRow(first);
                      }}
                    >
                      <span className="src-num">{line}</span>
                      <code className="src-text">
                        {tokens.map((token, i) => (
                          <span key={i} className={`cpp-${token.kind}`}>
                            {token.text}
                          </span>
                        ))}
                        {tokens.length === 0 && ' '}
                      </code>
                      {ran.length > 0 && (
                        <span className="src-ran" title={ran.map((r) => r.detail).join('\n')}>
                          ran
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="note muted source-window-note" data-testid="source-window">
                showing lines {viewWindow.from}&ndash;{viewWindow.to} of {facts?.lines ?? 0}
                {viewWindow.clipped && (
                  <>
                    {' '}
                    &middot;{' '}
                    <span className="warn-inline">
                      clipped at {MAX_RENDERED_LINES} rendered lines
                    </span>
                  </>
                )}
                {symbol !== null && (
                  <>
                    {' '}
                    &middot; <code>{symbol.id}</code> is{' '}
                    <code>
                      {shortFile(symbol.file)}:{symbol.startLine}&ndash;{symbol.endLine}
                    </code>
                  </>
                )}
              </p>
            </>
          )}
        </div>

        {/* ------------------------------------------------------- context */}
        <div className="source-context">
          {symbol === null ? (
            <p className="note muted" data-testid="source-hint">
              Pick a symbol on the left, or click anything in the architecture graph, the causal
              trace or the 3D robot — all four panes share one selection. Line numbers here are the
              pinned tree&rsquo;s own, and the file is hashed against{' '}
              <code>hardware/source-annotations.json</code> before it is drawn.
            </p>
          ) : (
            <SymbolDetail
              symbol={symbol}
              selection={selection}
              hitRows={hitRows}
              onSelectNode={onSelectNode}
              onSelectJoint={onSelectJoint}
              onSelectSymbol={onSelectSymbol}
              onSelectRow={onSelectRow}
              probeDeg={probeDeg}
              onProbeDeg={setProbeDeg}
            />
          )}

          {concept !== null && (
            <ConceptPanel
              concept={concept}
              siblings={concepts}
              level={level}
              onLevel={setLevel}
              onFocus={(id) => {
                setFocusConcept(id);
                setConceptPage(0);
              }}
              page={conceptPage}
              onPage={setConceptPage}
              onSelectSymbol={onSelectSymbol}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// The integrity gate
// ===========================================================================

/**
 * The one component that is allowed to stop the pane.
 *
 * Rendering nothing is the correct output for three of the five states. The
 * fourth — `mismatch` — prints both hashes and both line counts, because the
 * difference between "someone edited a line" and "this is a different file"
 * changes what the reader should do next.
 */
function SourceIntegrity({ load }: { readonly load: SourceLoad }): ReactElement {
  if (load.status === 'ok') {
    return (
      <p className="source-integrity ok" data-testid="source-integrity" data-status="ok">
        <span className="prov prov-observed">sha256 verified</span> {load.lines.length} lines ·{' '}
        <code className="mono">{load.sha256.slice(0, 16)}…</code> matches{' '}
        <code>source-annotations.json</code>
      </p>
    );
  }
  if (load.status === 'loading') {
    return (
      <p className="source-integrity" data-testid="source-integrity" data-status="loading">
        hashing {shortFile(load.file)}…
      </p>
    );
  }
  if (load.status === 'missing') {
    return (
      <div className="warn source-integrity" data-testid="source-integrity" data-status="missing">
        <strong>Source unavailable</strong>
        <p>
          <code>firmware/upstream/{load.file}</code> is not in this build.{' '}
          <code>firmware/upstream/</code> is gitignored, so it is fetched rather than committed.
          Run <code>scripts/fetch-upstream</code> and rebuild.
        </p>
        <p className="muted small">
          The annotations, the architecture graph and the trace are unaffected — they carry their
          own citations. Only the rendered text is missing.
        </p>
      </div>
    );
  }
  if (load.status === 'mismatch') {
    return (
      <div className="warn source-integrity" data-testid="source-integrity" data-status="mismatch">
        <strong>Refusing to render: this is not the annotated tree</strong>
        <p>
          <code>{load.file}</code> does not match what{' '}
          <code>hardware/source-annotations.json</code> was written against. Every symbol range and
          citation is a line offset into that one tree, so showing this file would put correct
          highlights around the wrong code.
        </p>
        <dl className="kv">
          <dt>expected</dt>
          <dd className="mono small" data-testid="source-expected-sha">
            {load.expectedSha256} · {load.expectedLines} lines
          </dd>
          <dt>received</dt>
          <dd className="mono small" data-testid="source-actual-sha">
            {load.actualSha256} · {load.actualLines} lines
          </dd>
        </dl>
        <p className="muted small">
          Re-run <code>scripts/fetch-upstream</code>, or regenerate the annotations with{' '}
          <code>pnpm build:source-annotations</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="warn source-integrity" data-testid="source-integrity" data-status="error">
      <strong>Could not load source</strong>
      <p>{load.detail}</p>
    </div>
  );
}

// ===========================================================================
// The symbol pane — architecture node, robot part, runtime event
// ===========================================================================

interface SymbolDetailProps {
  readonly symbol: SourceSymbol;
  readonly selection: SelectionState;
  readonly hitRows: readonly TraceRow[];
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly onSelectJoint: (joint: JointName | null) => void;
  readonly onSelectSymbol: (symbolId: string | null) => void;
  readonly onSelectRow: (row: TraceRow) => void;
  readonly probeDeg: number;
  readonly onProbeDeg: (deg: number) => void;
}

function SymbolDetail(props: SymbolDetailProps): ReactElement {
  const {
    symbol,
    selection,
    hitRows,
    onSelectNode,
    onSelectJoint,
    onSelectSymbol,
    onSelectRow,
    probeDeg,
    onProbeDeg,
  } = props;

  const nodes = archNodesInSymbol(symbol.id);
  const notes = notesForSymbol(symbol);
  const joints = jointsOf(symbol);
  const modules = modulesForSymbol(symbol);

  return (
    <div className="source-detail" data-testid="source-symbol-detail" data-symbol-id={symbol.id}>
      <h3>
        <code>{symbol.id}</code> <span className="dim">{symbol.kind}</span>
      </h3>
      <p className="mono small muted">
        {shortFile(symbol.file)}:{symbol.startLine}&ndash;{symbol.endLine} · {symbol.lineCount} lines
      </p>
      <p className="source-signature mono small">{symbol.signature}</p>

      {/* FACT: checkable against the cited lines. */}
      <p className="source-description" data-testid="source-description">
        {symbol.description}
      </p>

      {/* JUDGEMENT: deliberately not shaped like the sentence above it. */}
      {symbol.commentary !== null && (
        <aside className="source-commentary" data-commentary="symbol">
          <span className="source-commentary-tag">our reading — a judgement, not the code</span>
          <p>{symbol.commentary}</p>
        </aside>
      )}

      {/* --------------------------------------------- architecture node */}
      <h4 className="source-h4">Architecture</h4>
      {nodes.length === 0 ? (
        <p className="note muted">
          No architecture node cites a line in this span. <code>hardware-map.json</code> records no
          entity here, which is a fact about the map, not about the code.
        </p>
      ) : (
        <>
          <div className="chip-row" data-testid="source-arch-nodes">
            {nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`chip chip-node${node.id === selection.nodeId ? ' is-selected' : ''}`}
                data-source-arch-node={node.id}
                title={`${node.summary}\ncites ${node.sourceRef?.file ?? ''}:${String(node.sourceRef?.line ?? 0)}`}
                onClick={() => onSelectNode(node.id)}
              >
                {node.label}
              </button>
            ))}
          </div>
          {nodes.length > 1 && (
            <p className="note muted">
              {nodes.length} nodes cite lines inside this one span, so no single node <em>is</em>{' '}
              this code. All of them are highlighted as related instead of one being guessed at.
            </p>
          )}
          {nodes.map((node) => {
            const agreement = derivedFromAgreement(node, symbol);
            if (agreement.agrees || agreement.symbolSays.length === 0) return null;
            return (
              <p key={node.id} className="note source-disagreement" data-disagreement={node.id}>
                <span className="warn-inline">provenance spelt two ways</span>: the graph derives{' '}
                <code>{node.id}</code> from <code>{agreement.nodeSays}</code>; the annotation cites{' '}
                <code>{agreement.symbolSays.join(', ')}</code>. Both point into{' '}
                <code>hardware-map.json</code>; neither side is normalised into the other.
              </p>
            );
          })}
        </>
      )}

      {/* ------------------------------------------------------ robot part */}
      <h4 className="source-h4">Robot parts</h4>
      {joints.length === 0 ? (
        <p className="note muted">This span commands no joint.</p>
      ) : (
        <>
          <div className="chip-row" data-testid="source-joints">
            {joints.map((joint) => (
              <button
                key={joint}
                type="button"
                className={`chip chip-joint${joint === selection.joint ? ' is-selected' : ''}`}
                data-source-joint={joint}
                onClick={() => onSelectJoint(joint)}
              >
                {joint}
              </button>
            ))}
          </div>
          <p className="note muted small">
            Firmware enum order, never re-sorted. Joint identity is <code>R1</code>…<code>L4</code>{' '}
            only — the firmware has no notion of a hip, a leg or a side.
          </p>
          {symbol.robotPartsTransitive !== undefined &&
            symbol.robotPartsTransitive.length > joints.length && (
              <p className="note muted small">
                through calls it reaches{' '}
                <code>{symbol.robotPartsTransitive.join(' ')}</code>
              </p>
            )}
          {selection.joint !== null && <CommandsJoint joint={selection.joint} onSelectSymbol={onSelectSymbol} />}
          <ServoResolutionNote deg={probeDeg} onDeg={onProbeDeg} />
        </>
      )}

      {/* ---------------------------------------------------- runtime event */}
      <h4 className="source-h4">Runtime</h4>
      {hitRows.length === 0 ? (
        <p className="note muted">
          No row in the trace on screen ran inside this span. Fire a command to populate it.
        </p>
      ) : (
        <ul className="source-rows" data-testid="source-trace-rows">
          {hitRows.slice(0, 8).map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="source-row"
                data-source-trace-row={row.id}
                data-layer={row.layer}
                onClick={() => onSelectRow(row)}
                title={row.detail}
              >
                <code>{row.layer}</code> <span>{row.label}</span>
                {row.sourceRef !== null && (
                  <span className="mono muted"> :{row.sourceRef.line}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(symbol.crossRefs.commands?.length ?? 0) > 0 && (
        <p className="note muted small">
          command vocabulary: <code>{(symbol.crossRefs.commands ?? []).join(' ')}</code>
        </p>
      )}
      {(symbol.crossRefs.routes?.length ?? 0) > 0 && (
        <p className="note muted small">
          HTTP routes: <code>{(symbol.crossRefs.routes ?? []).join(' ')}</code>
        </p>
      )}
      {(symbol.crossRefs.calls?.length ?? 0) > 0 && (
        <p className="note muted small">
          calls:{' '}
          {(symbol.crossRefs.calls ?? []).map((id) => (
            <button
              key={id}
              type="button"
              className="linkish mono"
              data-source-call={id}
              onClick={() => onSelectSymbol(id)}
              disabled={!SYMBOL_BY_ID.has(id)}
            >
              {id}
            </button>
          ))}
        </p>
      )}

      {/* --------------------------------------------------- teaching notes */}
      {notes.length > 0 && (
        <>
          <h4 className="source-h4">Sharp edges</h4>
          {notes.map((note) => (
            <TeachingNoteCard key={note.id} note={note} />
          ))}
        </>
      )}

      {/* ------------------------------------------------------- curriculum */}
      {modules.length > 0 && (
        <>
          <h4 className="source-h4">Modules</h4>
          <div className="chip-row" data-testid="source-modules">
            {modules.slice(0, 8).map((module) => (
              <span
                key={module.id}
                className={`chip chip-module${module.grounding === 'conceptual' ? ' is-conceptual' : ''}`}
                data-module={module.id}
                data-grounding={module.grounding}
                title={
                  module.grounding === 'conceptual'
                    ? `CONCEPTUAL — ${module.conceptualReason ?? 'no backing firmware symbol'}`
                    : (module.groundingNote ?? module.realSesameConcept)
                }
              >
                {module.module}
                {module.grounding === 'conceptual' && (
                  <span className="chip-badge" data-testid={`conceptual-${module.id}`}>
                    conceptual
                  </span>
                )}
              </span>
            ))}
          </div>
          <p className="note muted small">
            A <b>conceptual</b> module has no backing symbol anywhere in the pinned firmware, so it
            may not be framed as &ldquo;this is how Sesame actually works&rdquo;.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * “Which line moved this leg?”, ranked.
 *
 * 26 of the 90 symbols name `R1`, so the honest answer is a list and the useful
 * answer is a *short* one. {@link symbolsCommanding} ranks by specificity —
 * fewest joints first, then shortest span — so `runWavePose` (four joints,
 * 17 lines) leads and `setup()` (all eight, 240 lines) does not.
 */
function CommandsJoint(props: {
  readonly joint: JointName;
  readonly onSelectSymbol: (id: string) => void;
}): ReactElement {
  const { joint, onSelectSymbol } = props;
  const ranked = symbolsCommanding(joint);
  return (
    <div className="source-commands-joint" data-testid="commands-joint" data-joint={joint}>
      <p className="note muted small">
        {ranked.length} annotated spans command <code>{joint}</code>, most specific first:
      </p>
      <div className="chip-row">
        {ranked.slice(0, 6).map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="chip chip-symbol"
            data-commands-joint-symbol={entry.id}
            title={`${entry.signature} · commands ${entry.robotParts.join(' ')}`}
            onClick={() => onSelectSymbol(entry.id)}
          >
            {entry.id}
          </button>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// TN-007 — the thing the UI must never imply away
// ===========================================================================

/**
 * What a commanded angle actually produces at the pin.
 *
 * TN-007: the LEDC channels are 10-bit, so a 20 ms frame is 1024 ticks and only
 * ticks 37…128 are reachable across 0–180°. **92 distinct pulses for 181
 * commands — 89 of the 181 angles are indistinguishable from a neighbour.** Any
 * surface in this app that renders a degree without saying so is over-claiming
 * a precision the design does not have.
 *
 * The arithmetic is `@sesame-lab/sesame-model`'s, which reproduces ESP32Servo
 * 3.0.9 exactly. It is not a measurement: per `docs/plan.md` no pulse in this
 * project has ever been, or will ever be, observed on hardware.
 */
function ServoResolutionNote(props: {
  readonly deg: number;
  readonly onDeg: (deg: number) => void;
}): ReactElement {
  const { deg, onDeg } = props;
  const pulse = quantiseCommandedAngle(deg);
  const aliases = anglesIndistinguishableFrom(deg);
  return (
    <div className="source-quantisation" data-testid="servo-resolution">
      <div className="source-quantisation-head">
        <span>command</span>
        <input
          type="range"
          min={0}
          max={180}
          step={1}
          value={deg}
          data-testid="servo-probe"
          onChange={(event) => onDeg(Number(event.target.value))}
        />
        <code>{deg}°</code>
      </div>
      <p className="small">
        asks for <code>{pulse.mappedUs.toFixed(0)} µs</code>, emits{' '}
        <code data-testid="servo-pulse-us">{pulse.pulseUs.toFixed(2)} µs</code> (tick {pulse.ticks}{' '}
        of {SERVO_TIMER_WIDTH_TICKS})
        {aliases.length === 0 ? (
          <> — distinguishable.</>
        ) : (
          <>
            {' '}
            — <b>identical</b> to <code>{aliases.join('°, ')}°</code>.
          </>
        )}
      </p>
      <p className="muted small">
        {SERVO_PULSE_QUANTISATION.commandableAngles} commandable angles,{' '}
        {SERVO_PULSE_QUANTISATION.distinctPulseValues} distinct pulses:{' '}
        {SERVO_PULSE_QUANTISATION.aliasedAngleCount} of them alias onto a neighbour (TN-007). These
        are commanded values. Nothing in this project has been observed on hardware, and nothing
        ever will be.
      </p>
    </div>
  );
}

// ===========================================================================
// Teaching notes — three registers, three treatments
// ===========================================================================

function TeachingNoteCard({ note }: { readonly note: TeachingNote }): ReactElement {
  return (
    <article
      className={`teaching-note tn-${note.kind}`}
      data-teaching-note={note.id}
      data-kind={note.kind}
      data-severity={note.severity}
    >
      <header>
        <span className="tn-kind">{note.kind}</span>
        <span className="tn-id mono">{note.id}</span>
        <b>{note.title}</b>
      </header>
      <p className="tn-summary">{note.summary}</p>

      {note.evidence.length > 0 && (
        <ul className="tn-evidence" data-testid={`evidence-${note.id}`}>
          {note.evidence.map((citation) => (
            <li key={`${citation.file}:${String(citation.line)}`}>
              <code className="mono">
                {shortFile(citation.file)}:{citation.line}
              </code>{' '}
              <span className="tn-line mono">{citation.text.trim()}</span>
            </li>
          ))}
        </ul>
      )}

      {/*
        A different tree. The pinned-commit line checker cannot resolve this and
        must not appear to: the citable identity is library + version + path +
        line, and it renders as such.
      */}
      {note.libraryEvidence !== null && (
        <div className="tn-library" data-library-evidence={note.id}>
          <span className="tn-library-tag">
            evidence from a library, not from this pinned tree
          </span>
          <p className="small">
            <code>
              {note.libraryEvidence.library} {note.libraryEvidence.version}
            </code>{' '}
            → <code className="mono">
              {note.libraryEvidence.file}:{note.libraryEvidence.line}
            </code>
          </p>
          <p className="tn-line mono small">{note.libraryEvidence.text}</p>
        </div>
      )}

      {note.commentary !== null && (
        <aside className="source-commentary" data-commentary={note.id}>
          <span className="source-commentary-tag">our reading — a judgement, not the code</span>
          <p>{note.commentary}</p>
        </aside>
      )}

      {note.references.length > 0 && (
        <p className="muted small tn-refs">{note.references.join(' · ')}</p>
      )}
    </article>
  );
}

// ===========================================================================
// Concepts — optional depth, and a cap instead of a hairball
// ===========================================================================

interface ConceptPanelProps {
  readonly concept: SourceConcept;
  readonly siblings: readonly SourceConcept[];
  readonly level: LevelKey;
  readonly onLevel: (level: LevelKey) => void;
  readonly onFocus: (id: string) => void;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly onSelectSymbol: (id: string) => void;
}

/**
 * One concept, at one of three depths.
 *
 * The report is explicit that optional depth beats walls of text, so exactly
 * one of `beginner12` / `beginnerProgrammer` / `architecture` is on screen at a
 * time and the other two are one click away. Showing all three at once would be
 * the wall the report warns about, in triplicate.
 *
 * The symbol list is **ranked and capped** rather than drawn as a graph. L3
 * warns that `concepts[].symbols` is dense — `face` claims 38 of the 90 symbols,
 * `timing` and `animation` 33 each — so an edge-per-symbol diagram is a
 * hairball and a full alphabetical list is a wall. `rankConceptSymbols()` puts
 * the concept's own `primaryAnchor` first, then the symbols that are most about
 * this concept and least sprawling, six at a time.
 */
function ConceptPanel(props: ConceptPanelProps): ReactElement {
  const { concept, siblings, level, onLevel, onFocus, page, onPage, onSelectSymbol } = props;
  const ranked = useMemo(() => rankConceptSymbols(concept.id), [concept.id]);
  const pages = Math.max(1, Math.ceil(ranked.length / CONCEPT_PAGE));
  const shown = ranked.slice(page * CONCEPT_PAGE, page * CONCEPT_PAGE + CONCEPT_PAGE);

  return (
    <div className="source-concepts" data-testid="source-concepts" data-concept={concept.id}>
      <h4 className="source-h4">Concepts</h4>
      <div className="chip-row">
        {siblings.map((sibling) => (
          <button
            key={sibling.id}
            type="button"
            className={`chip chip-concept${sibling.id === concept.id ? ' is-selected' : ''}`}
            data-source-concept={sibling.id}
            onClick={() => onFocus(sibling.id)}
          >
            {sibling.label}
            <span className="chip-badge">{sibling.symbols.length}</span>
          </button>
        ))}
      </div>

      <div className="level-switch" role="tablist">
        {LEVELS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            className={`level-tab${entry.key === level ? ' active' : ''}`}
            data-level={entry.key}
            aria-selected={entry.key === level}
            onClick={() => onLevel(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <p className="concept-text" data-testid="concept-text" data-shown-level={level}>
        {concept.levels[level]}
      </p>
      {concept.verbatimFromReport && (
        <p className="muted small">wording taken verbatim from the research report</p>
      )}

      {concept.primaryAnchor !== null && (
        <p className="note muted small">
          anchored at{' '}
          <button
            type="button"
            className="linkish mono"
            onClick={() => {
              const anchor = concept.primaryAnchor?.symbol;
              if (anchor !== undefined) onSelectSymbol(anchor);
            }}
          >
            {shortFile(concept.primaryAnchor.file)}:{concept.primaryAnchor.line}
          </button>
        </p>
      )}

      <div className="concept-symbols" data-testid="concept-symbols">
        {shown.map((entry) => (
          <button
            key={entry.symbol.id}
            type="button"
            className={`chip chip-symbol${entry.isAnchor ? ' is-anchor' : ''}`}
            data-concept-symbol={entry.symbol.id}
            data-rank-score={entry.score.toFixed(3)}
            title={`${entry.symbol.signature} · ${String(entry.symbol.lineCount)} lines`}
            onClick={() => onSelectSymbol(entry.symbol.id)}
          >
            {entry.symbol.id}
          </button>
        ))}
      </div>
      {ranked.length === 0 ? (
        <p className="note muted small" data-testid="concept-no-symbols">
          This concept has <b>no</b> backing symbol, and that is correct: nothing in the firmware
          describes its own execution environment. It is reported rather than force-fitted.
        </p>
      ) : (
        <p className="note muted small">
          <span data-testid="concept-density">{ranked.length}</span> symbols teach this concept;
          showing {shown.length}, ranked by anchor, centrality and span.{' '}
          {pages > 1 && (
            <button
              type="button"
              className="linkish"
              data-testid="concept-page"
              onClick={() => onPage((page + 1) % pages)}
            >
              next {page + 1}/{pages}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
