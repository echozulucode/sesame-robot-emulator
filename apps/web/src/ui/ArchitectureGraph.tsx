/**
 * The architecture view — three representations of ONE model.
 *
 * Phase 4 W4. What was here before was a single artifact: React Flow drawing
 * all 63 nodes at whatever zoom `fitView` could find, in whatever width the
 * pane happened to have. W1 measured what that costs — node labels at 8.0 px in
 * a 1440 px window and 3.8 px in an 880 px one, on a surface already three to
 * six times below the 14 px floor — and recorded that growing the type made it
 * *worse*, because a bigger box zooms out further.
 *
 * The brief's answer is not a type size. It is three artifacts:
 *
 * ```text
 *  < 720 px of graph box   causal path      the chain to one part + its branches
 *  720-959                 subsystem graph  one neighbourhood, <= 18 nodes, zoom 1
 *  >= 960                  full graph       all 63 nodes, React Flow as built
 *  explicit action         focus workspace  the robot becomes a live reference
 * ```
 *
 * **React chooses; CSS does not hide.** `useContainerWidth()` measures this
 * surface with a `ResizeObserver` and `archModeForWidth()` picks the artifact,
 * so the 63-node graph is not in the tree at all below 720 px. Mounting it and
 * hiding it would waste the layout work and leave two DOMs claiming to be the
 * same diagram — the brief is explicit that this is the mistake that makes
 * responsive React expensive.
 *
 * ## What is the same in all three
 *
 * - `SelectionState`. Every node in every representation is `[data-arch-node]`
 *   and calls the same `onSelect`, so the cross-highlight Phase 2 spent the
 *   most effort on — 3D scene, graph, trace, inspector, source — is one object
 *   and one code path, not three.
 * - The five hand-authored claims, dashed and enumerated.
 * - `MG90S` unresolved, in the warning colour, quoting its own reason.
 * - No LEDC channel number anywhere: `channelPerJointKnown` is still `false`.
 *
 * ## `data-zoom-surface` is now the FULL graph's alone
 *
 * W1 put it on the canvas so the type invariant could not silently absorb the
 * zoom debt. That debt belongs to the 63-node map: in the path view there is no
 * transform at all, and in the subsystem view the zoom floor is 1, so in both
 * of those the authored size IS the on-screen size and the ordinary 14 px floor
 * applies with no exemption. Only `full` still declares itself, and it still
 * cannot meet the floor when fitted — see the findings.
 */
import {
  Background,
  BackgroundVariant,
  Controls as FlowControls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
/* React Flow's stylesheet is imported by `styles.css` into the `reset` cascade
   layer — an unlayered import here outranks every layer in that file. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { ArchitecturePath } from './ArchitecturePath.js';
import { useContainerWidth } from './use-container-width.js';

import {
  ARCH_NODE_BY_ID,
  HAND_AUTHORED,
  UPSTREAM_COMMIT,
  type ArchNode,
} from '../generated/architecture-graph.js';
import {
  childrenOf,
  FULL_METRICS,
  layoutArchitecture,
  SUBSYSTEM_METRICS,
  type LayoutMetrics,
} from '../arch/layout.js';
import {
  archModeForWidth,
  ARCH_BANDS,
  ARCH_SUBSYSTEM_MAX_NODES,
  causalPath,
  focusNodeFor,
  subsystemForNode,
  subsystemScope,
  SUBSYSTEMS,
  type ArchitectureMode,
} from '../arch/representation.js';
import { nodeIsRelated, nodeIsSelected, type SelectionState } from '../state/selection.js';
import { type Trace, type TraceRow } from '../state/trace-store.js';

export interface ArchitectureGraphProps {
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly selection: SelectionState;
  readonly onSelect: (nodeId: string | null) => void;
  /** Node ids the current trace touched. Lights the active path. */
  readonly activeNodeIds: ReadonlySet<string>;
  /** The trace on screen. The narrow view lists the events this chain made. */
  readonly trace: Trace | null;
  readonly onSelectRow: (row: TraceRow) => void;
  /** True while the focus workspace is giving this pane the content area. */
  readonly workspaceOpen: boolean;
  readonly onWorkspaceChange: (open: boolean) => void;
}

interface SesameNodeData extends Record<string, unknown> {
  readonly arch: ArchNode;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly hiddenChildren: number;
  readonly selected: boolean;
  readonly related: boolean;
  readonly active: boolean;
  readonly compact: boolean;
  readonly width: number;
  readonly height: number;
  readonly onToggle: (id: string) => void;
}

/**
 * One box.
 *
 * Deliberately not a generic label: the summary line is the node's own derived
 * one-liner (`92 of 181 angles distinguishable`, `10 routes on port 80`), which
 * is the difference between a diagram and a diagram that teaches.
 */
function SesameNode({ data }: NodeProps<Node<SesameNodeData>>): ReactElement {
  const {
    arch,
    expandable,
    expanded,
    hiddenChildren,
    selected,
    related,
    active,
    compact,
    width,
    height,
    onToggle,
  } = data;
  const classes = [
    'arch-node',
    `arch-kind-${arch.kind}`,
    compact ? 'is-compact' : '',
    selected ? 'is-selected' : '',
    related ? 'is-related' : '',
    active ? 'is-active' : '',
    arch.derivation === 'hand-authored' ? 'is-hand-authored' : '',
    arch.unresolved !== null ? 'is-unresolved' : '',
  ]
    .filter((c) => c.length > 0)
    .join(' ');

  return (
    <div
      className={classes}
      style={{ width, height }}
      data-arch-node={arch.id}
      data-selected={String(selected)}
      data-active={String(active)}
      data-derivation={arch.derivation}
      title={arch.summary}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="arch-node-label">
        {arch.label}
        {arch.unresolved !== null && (
          <span className="arch-flag" title={`hardware-map.json → unresolved[${arch.unresolved}]`}>
            ?
          </span>
        )}
      </div>
      <div className="arch-node-summary">{arch.summary}</div>
      {expandable && !compact && (
        <button
          type="button"
          className="arch-expand"
          data-expand={arch.id}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(arch.id);
          }}
          title={expanded ? 'collapse' : `expand — ${hiddenChildren} more from the data`}
        >
          {expanded ? '−' : `+${hiddenChildren}`}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { sesame: SesameNode };

/**
 * Re-frame the viewport when the graph changes shape.
 *
 * React Flow's `fitView` prop only fires on mount, so without this an expansion
 * adds nine rows of chain below the fold and the learner sees nothing happen.
 *
 * **Two regimes, because the two representations have different jobs.**
 *
 * `full` fits, and expanding **focuses**: the viewport fits the node that was
 * opened plus its children rather than zooming out to fit the whole graph.
 *
 * `subsystem` never zooms out. Its whole reason for existing is that a label
 * shrunk to 6 px is not a label, so the zoom floor is 1 and what moves is the
 * viewport, centred on the focus node and its immediate neighbours. That makes
 * a cross-highlight visible rather than merely correct: selecting `R4` in the
 * 3D scene pans this graph to `R4`.
 */
function Reframe({
  mode,
  layoutKey,
  expanded,
  visibleIds,
  focusId,
  pathIds,
  widthKey,
}: {
  readonly mode: ArchitectureMode;
  readonly layoutKey: string;
  readonly expanded: ReadonlySet<string>;
  readonly visibleIds: readonly string[];
  readonly focusId: string;
  /** The causal chain to the focus, for the subsystem view's frame. */
  readonly pathIds: readonly string[];
  /**
   * The surface's width, as a re-frame trigger.
   *
   * React Flow's `fitView` PROP fires on mount only, and its viewport is a
   * transform rather than a layout: growing the box leaves the graph at the
   * zoom it was fitted at. Measured at 1760x1000 before this dependency
   * existed, opening the focus workspace took the canvas from 351 px to
   * 1,201 px and left the labels at 5.7 px on screen - a wider box showing
   * exactly the same unreadable picture, which would have made the whole
   * workspace a decoration.
   */
  readonly widthKey: number | null;
}): null {
  const flow = useReactFlow();
  const previous = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = expanded;
    const opened = before === null ? [] : [...expanded].filter((id) => !before.has(id));
    const focus: string | null = opened.length === 1 ? (opened[0] as string) : null;
    // Two frames: React Flow measures nodes after paint, and fitting against
    // unmeasured nodes lands the viewport somewhere arbitrary.
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (mode === 'subsystem') {
          // The focus, what it leads to, and what led TO it. The predecessor is
          // what makes the frame answer a question rather than centre a box:
          // for `R1` it brings `MG90S` into view, which is "which servo drives
          // this joint" - and it is the hand-authored edge, so the frame that
          // teaches is also the frame that shows where the evidence stops.
          const previous = pathIds[pathIds.indexOf(focusId) - 1];
          const around = [
            ...(previous === undefined ? [] : [previous]),
            focusId,
            ...childrenOf(focusId).map((c) => c.id),
          ].filter((n) => visibleIds.includes(n));
          const nodes = around.length > 0 ? around : visibleIds.slice(0, 4);
          void flow.fitView({
            nodes: nodes.map((n) => ({ id: n })),
            padding: 0.12,
            minZoom: 1,
            maxZoom: 1,
            duration: 200,
          });
          return;
        }
        if (focus !== null) {
          const subtree = [focus, ...childrenOf(focus).map((c) => c.id)].filter((n) =>
            visibleIds.includes(n),
          );
          void flow.fitView({ nodes: subtree.map((n) => ({ id: n })), padding: 0.2, duration: 260 });
          return;
        }
        void flow.fitView({ padding: 0.16, duration: 260 });
      }),
    );
    return () => cancelAnimationFrame(id);
    // `layoutKey` is what actually changed; `expanded` is read for the diff.
  }, [flow, mode, layoutKey, expanded, visibleIds, focusId, pathIds, widthKey]);

  return null;
}

export function ArchitectureGraph(props: ArchitectureGraphProps): ReactElement {
  return (
    <ReactFlowProvider>
      <ArchitectureGraphInner {...props} />
    </ReactFlowProvider>
  );
}

/** What the header says about each artifact, in the reader's words. */
const MODE_NOTE: Readonly<Record<ArchitectureMode, string>> = {
  path: 'one chain, readable',
  subsystem: 'one subsystem',
  full: 'all 63 nodes',
};

function ArchitectureGraphInner(props: ArchitectureGraphProps): ReactElement {
  const {
    expanded,
    onToggle,
    selection,
    onSelect,
    activeNodeIds,
    trace,
    onSelectRow,
    workspaceOpen,
    onWorkspaceChange,
  } = props;

  /*
   * How wide is THIS surface — not this window, and not the pane, which is
   * wider by its own padding. See `arch/representation.ts` for why the smaller
   * box is the conservative one to branch on, and `ui/use-container-width.ts`
   * for why the answer has to come from a `ResizeObserver` rather than from
   * `@container`: what changes across these thresholds is which artifact is
   * MOUNTED, and CSS cannot decline to mount something.
   */
  const { ref: surfaceRef, widthPx: surfaceWidthPx, band } = useContainerWidth();
  const mode = archModeForWidth(surfaceWidthPx ?? Number.NaN);

  const focusId = useMemo(
    () => focusNodeFor(selection.nodeId, activeNodeIds),
    [selection.nodeId, activeNodeIds],
  );
  const path = useMemo(() => causalPath(focusId, activeNodeIds), [focusId, activeNodeIds]);

  // The subsystem follows the focus, and a reader may override it. The effect
  // is what keeps the cross-highlight true: selecting `R4` in the 3D scene puts
  // this pane on Movement, wherever it was.
  const focusSubsystem = subsystemForNode(focusId) ?? SUBSYSTEMS[0]?.id ?? 'movement';
  const [pickedSubsystem, setPickedSubsystem] = useState(focusSubsystem);
  useEffect(() => setPickedSubsystem(focusSubsystem), [focusSubsystem]);
  const scope = useMemo(
    () => subsystemScope(pickedSubsystem, focusId),
    [pickedSubsystem, focusId],
  );

  const metrics: LayoutMetrics = mode === 'subsystem' ? SUBSYSTEM_METRICS : FULL_METRICS;
  const layout = useMemo(
    () =>
      mode === 'subsystem'
        ? layoutArchitecture(expanded, { scope: scope.ids, metrics: SUBSYSTEM_METRICS })
        : layoutArchitecture(expanded),
    [mode, expanded, scope],
  );
  const visibleIds = useMemo(() => layout.nodes.map((p) => p.node.id), [layout]);
  const layoutKey = useMemo(() => `${mode}|${visibleIds.join('|')}`, [mode, visibleIds]);

  const nodes = useMemo<Node<SesameNodeData>[]>(
    () =>
      layout.nodes.map((p) => ({
        id: p.node.id,
        type: 'sesame',
        position: { x: p.x, y: p.y },
        draggable: false,
        data: {
          arch: p.node,
          expandable: p.expandable,
          expanded: p.expanded,
          hiddenChildren: p.hiddenChildren,
          selected: nodeIsSelected(p.node.id, selection),
          related: nodeIsRelated(p.node.id, selection),
          active: activeNodeIds.has(p.node.id),
          compact: mode === 'subsystem',
          width: metrics.nodeW,
          height: metrics.nodeH,
          onToggle,
        },
      })),
    [layout, selection, activeNodeIds, onToggle, mode, metrics],
  );

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => {
        const on = activeNodeIds.has(e.source) && activeNodeIds.has(e.target);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          animated: on,
          className: [
            e.derivation === 'hand-authored' ? 'arch-edge-hand' : 'arch-edge',
            e.lifted ? 'arch-edge-lifted' : '',
            on ? 'arch-edge-active' : '',
          ]
            .filter((c) => c.length > 0)
            .join(' '),
          ...(e.label === null ? {} : { label: e.label }),
          ...(e.derivation === 'hand-authored' ? { style: { strokeDasharray: '4 4' } } : {}),
        };
      }),
    [layout, activeNodeIds],
  );

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => onSelect(node.id === selection.nodeId ? null : node.id),
    [onSelect, selection.nodeId],
  );

  const detail = selection.nodeId === null ? null : (ARCH_NODE_BY_ID.get(selection.nodeId) ?? null);

  return (
    <section className="panel arch-panel" data-testid="architecture-graph" data-arch-mode={mode}>
      <header className="panel-header">
        <h2>Architecture</h2>
        <span className="panel-sub" data-testid="arch-mode-note">
          {mode === 'path'
            ? `${path.steps.length} steps · ${MODE_NOTE.path}`
            : mode === 'subsystem'
              ? `${layout.nodes.length} of ${scope.total + 1} in this subsystem`
              : `${layout.nodes.length} of ${ARCH_NODE_BY_ID.size} nodes`}{' '}
          · from hardware-map.json
        </span>
      </header>

      {/*
        THE representation switch, said out loud.

        A reader at 1440x900 is looking at a causal chain rather than a map, and
        a product that silently swapped its own central diagram would be lying
        by omission. So the pane names what it is showing, why, and what the one
        action is that gets the whole map back.
      */}
      <div className="arch-modebar" data-testid="arch-modebar">
        <span className="arch-mode-chip" data-arch-mode-chip={mode}>
          {mode === 'path' ? 'CAUSAL PATH' : mode === 'subsystem' ? 'SUBSYSTEM' : 'FULL GRAPH'}
        </span>
        <span className="arch-mode-why">
          {mode === 'full'
            ? `this pane has the ${ARCH_BANDS.full} px the whole map needs`
            : `${String(surfaceWidthPx ?? 0)} px of pane — the full 63-node map needs ${ARCH_BANDS.full}`}
        </span>
        <button
          type="button"
          className={`arch-workspace-btn${workspaceOpen ? ' is-open' : ''}`}
          data-testid="arch-workspace-toggle"
          aria-pressed={workspaceOpen}
          onClick={() => onWorkspaceChange(!workspaceOpen)}
          title={
            workspaceOpen
              ? 'give the stage back — the robot returns to at least half the screen'
              : 'give this pane the content area; Sesame stays live, smaller'
          }
        >
          {workspaceOpen ? 'Close architecture workspace' : 'Open architecture workspace'}
        </button>
      </div>

      {mode === 'subsystem' && (
        <div className="arch-subsystems" role="tablist" data-testid="arch-subsystems">
          {SUBSYSTEMS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === pickedSubsystem}
              className={`arch-subsystem${s.id === pickedSubsystem ? ' active' : ''}`}
              data-arch-subsystem={s.id}
              onClick={() => setPickedSubsystem(s.id)}
            >
              {s.label}
            </button>
          ))}
          {scope.omitted > 0 && (
            <span className="arch-subsystem-omitted" data-testid="arch-subsystem-omitted">
              {scope.omitted} more in this subsystem — the budget is{' '}
              {ARCH_SUBSYSTEM_MAX_NODES} nodes
            </span>
          )}
        </div>
      )}

      {/*
        `data-arch-mode`, `data-pane-band` and `data-pane-width-px` are on THIS
        box rather than on the canvas — Phase 4 W4 — because below 720 px there
        is no canvas: the artifact is ordinary flow text. W2 published the band
        on `.arch-canvas` when the canvas was the only thing that could be here.
      */}
      <div
        className="arch-surface"
        data-testid="arch-surface"
        data-arch-mode={mode}
        data-pane-band={band}
        data-pane-width-px={surfaceWidthPx === null ? '' : String(surfaceWidthPx)}
        ref={surfaceRef}
      >
        {mode === 'path' ? (
          <ArchitecturePath
            path={path}
            selection={selection}
            onSelect={onSelect}
            activeNodeIds={activeNodeIds}
            trace={trace}
            onSelectRow={onSelectRow}
          />
        ) : (
          <div
            className="arch-canvas"
            data-testid="arch-canvas"
            /*
              `data-zoom-surface` — W1, now scoped to the artifact that owes the
              debt. The subsystem view's zoom floor is 1, so its 15 px labels
              are 15 px on screen and the ordinary type invariant applies to it
              with no exemption at all. Only the 63-node map still needs one.
            */
            {...(mode === 'full' ? { 'data-zoom-surface': 'architecture' } : {})}
            data-2d-surface="graph"
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={onNodeClick}
              onPaneClick={() => onSelect(null)}
              fitView
              fitViewOptions={
                mode === 'subsystem'
                  ? { padding: 0.12, minZoom: 1, maxZoom: 1 }
                  : { padding: 0.16 }
              }
              minZoom={mode === 'subsystem' ? 1 : 0.15}
              maxZoom={2}
              proOptions={{ hideAttribution: false }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222a35" />
              <FlowControls showInteractive={false} />
              <Reframe
                mode={mode}
                layoutKey={layoutKey}
                expanded={expanded}
                visibleIds={visibleIds}
                focusId={focusId}
                pathIds={path.nodeIds}
                widthKey={surfaceWidthPx}
              />
            </ReactFlow>
          </div>
        )}
      </div>

      {detail === null ? (
        <p className="note muted" data-testid="arch-hint">
          Click a box to see where it came from. <code>+n</code> expands into the chain the firmware
          actually walks; every one of those nodes is projected from{' '}
          <code>hardware/hardware-map.json</code> at upstream{' '}
          <code>{UPSTREAM_COMMIT.slice(0, 7)}</code>. Dashed edges and dashed borders mark the{' '}
          {HAND_AUTHORED.length} claims the data cannot express.
        </p>
      ) : (
        <div className="arch-detail" data-testid="arch-detail" data-node-id={detail.id}>
          <h3>
            {detail.label} <span className="dim">{detail.kind}</span>
          </h3>
          <p className="arch-detail-summary">{detail.summary}</p>
          <ul className="arch-detail-list">
            {detail.detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <dl className="kv">
            <dt>derived from</dt>
            <dd className="mono small" data-testid="arch-derived-from">
              {detail.derivation === 'hand-authored' ? (
                <span className="warn-inline">
                  hand-authored — no artefact in this repository states this. Shown because the
                  structure would be misleading without it, and marked because it is not evidence.
                </span>
              ) : (
                <>
                  <code>hardware-map.json → {detail.derivedFrom}</code>
                </>
              )}
            </dd>
            {detail.sourceRef !== null && (
              <>
                <dt>source</dt>
                <dd className="mono small" data-testid="arch-source-ref">
                  <code>
                    {detail.sourceRef.file}:{detail.sourceRef.line}
                  </code>{' '}
                  <span className="muted">@ {UPSTREAM_COMMIT.slice(0, 7)}</span>
                </dd>
              </>
            )}
            {detail.unresolved !== null && (
              <>
                <dt>unresolved</dt>
                <dd>
                  <span className="warn-inline">
                    <code>{detail.unresolved}</code> — the part exists and its properties do not,
                    anywhere in this repository. It cannot be settled without hardware, and there
                    will be no hardware.
                  </span>
                </dd>
              </>
            )}
            {childrenOf(detail.id).length > 0 && (
              <>
                <dt>expands into</dt>
                <dd className="small">{childrenOf(detail.id).length} nodes</dd>
              </>
            )}
            {detail.joints.length > 0 && (
              <>
                <dt>joints</dt>
                <dd className="mono small">{detail.joints.join(' ')}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}
