/**
 * The interactive architecture view, drawn with React Flow (MIT, `@xyflow/react`).
 *
 * It starts at the real top level and expands into the real chains:
 *
 * ```text
 * ESP32                          click Servos          click OLED
 *  ├─ Movement → 8 Servos        movement function     face name
 *  ├─ Face → OLED                setServoAngle         bitmap frame
 *  ├─ Network → HTTP API         ESP32Servo            Adafruit_GFX
 *  └─ Serial → Developer         LEDC / PWM            Adafruit_SSD1306
 *                                GPIO                  Wire
 *                                MG90S                 I²C 0x3C
 *                                R1 … L4               SSD1306 controller
 *                                                      128×64 pixels
 * ```
 *
 * Every node comes out of `src/generated/architecture-graph.ts`, which is
 * projected from `hardware/hardware-map.json` by a checked generator. Nothing
 * in this file knows a pin number, a line number or a library name; it knows
 * how to draw whatever the data says. The five claims the data cannot express
 * are marked `hand-authored` in the generator and render with a visible dashed
 * marker here — a learner can see exactly where the evidence stops.
 *
 * The report notes that the same graph should become the "See the Signal"
 * canvas rather than there being two unrelated diagram systems. That is what
 * `activeNodeIds` does: the trace hands back the node ids its rows touched and
 * they light up on this one graph.
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
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react';

import { useContainerWidth } from './use-container-width.js';

import {
  ARCH_NODE_BY_ID,
  HAND_AUTHORED,
  UPSTREAM_COMMIT,
  type ArchNode,
} from '../generated/architecture-graph.js';
import { childrenOf, layoutArchitecture, NODE_H, NODE_W } from '../arch/layout.js';
import { nodeIsRelated, nodeIsSelected, type SelectionState } from '../state/selection.js';

export interface ArchitectureGraphProps {
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly selection: SelectionState;
  readonly onSelect: (nodeId: string | null) => void;
  /** Node ids the current trace touched. Lights the active path. */
  readonly activeNodeIds: ReadonlySet<string>;
}

interface SesameNodeData extends Record<string, unknown> {
  readonly arch: ArchNode;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly hiddenChildren: number;
  readonly selected: boolean;
  readonly related: boolean;
  readonly active: boolean;
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
  const { arch, expandable, expanded, hiddenChildren, selected, related, active, onToggle } = data;
  const classes = [
    'arch-node',
    `arch-kind-${arch.kind}`,
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
      style={{ width: NODE_W, height: NODE_H }}
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
      {expandable && (
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
 * Expanding **focuses**: the viewport fits the node that was opened plus its
 * children, rather than zooming out to fit the whole graph. Fitting everything
 * is the wrong answer here — the expanded servo chain is nine rows deep, and an
 * overview of it is a column of unreadable grey boxes. Collapsing, or any other
 * change, refits the whole thing.
 */
function Reframe({
  layoutKey,
  expanded,
  visibleIds,
}: {
  readonly layoutKey: string;
  readonly expanded: ReadonlySet<string>;
  readonly visibleIds: readonly string[];
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
  }, [flow, layoutKey, expanded, visibleIds]);

  return null;
}

export function ArchitectureGraph(props: ArchitectureGraphProps): ReactElement {
  return (
    <ReactFlowProvider>
      <ArchitectureGraphInner {...props} />
    </ReactFlowProvider>
  );
}

function ArchitectureGraphInner(props: ArchitectureGraphProps): ReactElement {
  const { expanded, onToggle, selection, onSelect, activeNodeIds } = props;

  const layout = useMemo(() => layoutArchitecture(expanded), [expanded]);
  const visibleIds = useMemo(() => layout.nodes.map((p) => p.node.id), [layout]);
  const layoutKey = useMemo(() => visibleIds.join('|'), [visibleIds]);

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
          onToggle,
        },
      })),
    [layout, selection, activeNodeIds, onToggle],
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

  /*
   * How wide is THIS canvas — not this window. See `ui/use-container-width.ts`
   * for why the answer has to come from a `ResizeObserver` rather than from
   * `@container`: what changes across these thresholds is which artifact is
   * mounted, and CSS cannot decline to mount something.
   */
  const { ref: paneRef, widthPx: paneWidthPx, band } = useContainerWidth();

  return (
    <section className="panel arch-panel" data-testid="architecture-graph">
      <header className="panel-header">
        <h2>Architecture</h2>
        <span className="panel-sub">
          {layout.nodes.length} of {ARCH_NODE_BY_ID.size} nodes · from hardware-map.json
        </span>
      </header>

      {/*
        `data-zoom-surface` — Phase 4 W1.

        Everything inside React Flow's viewport is drawn through a CSS
        transform the READER controls: node labels are authored at 15px and
        edge labels at 14px, and at the zoom `fitView` picks for 63 nodes in a
        620px pane they land on screen at 3-5px. The harness measures the
        AUTHORED size inside this box rather than the transformed one, and
        records the zoom beside it, because the honest description of the
        problem is "the map does not fit in this pane", not "the type is too
        small". Shrinking the type would not help and enlarging it would not
        either; W4's three representations are the fix, and this attribute is
        what stops the type invariant from silently absorbing that debt.
      */}
      {/*
        `data-2d-surface` and `data-pane-band` — Phase 4 W2.

        The first is the pane contract's explicit opt-out: a pane owns exactly
        one ordinary vertical scroller, and anything else that a reader
        navigates in two dimensions has to say so by name. React Flow is a PAN
        surface rather than a scroller, but it is the same exemption and the
        harness lists it.

        The second is the measurement W4 will branch on. `useContainerWidth()`
        reports this canvas's own inline size, so `band` says whether this pane
        has room for a causal path (< 520 px), a subsystem neighbourhood
        (520-719) or the full 63-node map (>= 720) — and it says it about THIS
        PANE, which is the whole reason it is not a media query: the same 1440px
        window holds this canvas at 355 px in a docked column and at 607 px in
        an overlay.

        W4 mounts the three representations. What is decided here is the one
        thing that is not a representation: React Flow's decorative dot grid is
        not mounted in the narrow band. At the zoom `fitView` picks for 63 nodes
        in a 355 px canvas the nodes are already 3-5 px of text, and an 18 px
        dot lattice behind them competes with the artifact rather than framing
        it. It is left OUT of the tree rather than hidden with CSS, because the
        brief is explicit that mounting work you intend not to show is the
        mistake that makes responsive React expensive and its semantics
        duplicated.
      */}
      <div
        className="arch-canvas"
        data-testid="arch-canvas"
        data-zoom-surface="architecture"
        data-2d-surface="graph"
        data-pane-band={band}
        data-pane-width-px={paneWidthPx === null ? '' : String(paneWidthPx)}
        ref={paneRef}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={onNodeClick}
          onPaneClick={() => onSelect(null)}
          fitView
          fitViewOptions={{ padding: 0.16 }}
          minZoom={0.15}
          maxZoom={2}
          proOptions={{ hideAttribution: false }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
        >
          {band !== 'narrow' && (
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222a35" />
          )}
          <FlowControls showInteractive={false} />
          <Reframe layoutKey={layoutKey} expanded={expanded} visibleIds={visibleIds} />
        </ReactFlow>
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
