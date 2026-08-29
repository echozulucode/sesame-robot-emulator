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
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
/* React Flow's stylesheet is imported by `styles.css` into the `reset` cascade
   layer — an unlayered import here outranks every layer in that file. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { ArchitecturePath } from './ArchitecturePath.js';
import { useContainerWidth } from './use-container-width.js';
import { motionDurationMs } from './prefers-reduced-motion.js';

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
 * Re-frame the viewport when the graph changes SHAPE.
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
 * viewport, centred on the focus node and its immediate neighbours.
 *
 * ## Shape is not selection — and conflating them was a bug
 *
 * > *"the graph looks awesome. One complaint is that when I click on a node, it
 * > zooms out and I need to keep manually zooming in."*
 *
 * `focusId` and `pathIds` used to be DEPENDENCIES of this effect. A node click
 * changes the selection, which changes both, which re-ran the effect, which in
 * `full` fell through to `fitView({ padding: 0.16 })` — refitting all 63 nodes
 * and throwing away whatever zoom the reader had scrolled to. The whole map was
 * refitted as a side effect of asking about one box in it.
 *
 * They are read through a REF now, so the frame chosen when the shape changes
 * is still the frame around the current focus, and a selection on its own no
 * longer re-fits anything. {@link RevealSelection} is what answers a selection,
 * and it may only PAN: see its own comment.
 */
function Reframe({
  mode,
  layoutKey,
  expanded,
  visibleIds,
  focusId,
  pathIds,
  widthKey,
  expandWasExplicit,
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
  /**
   * True when the shape changed because the reader pressed `+n`.
   *
   * A ref rather than a prop value, because it is an EVENT and a prop would
   * make it part of the effect's dependency list — which is the exact mistake
   * this whole component is fixing. It is read and cleared once per effect run.
   */
  readonly expandWasExplicit: { current: boolean };
}): null {
  const flow = useReactFlow();
  const previous = useRef<ReadonlySet<string> | null>(null);
  /** The last shape/box this effect framed, so it can tell them apart. */
  const lastLayout = useRef<string | null>(null);
  const lastBox = useRef<string | null>(null);
  /*
    The focus and its chain, READ but not DEPENDED ON.

    The frame this effect chooses is still built around whatever is selected
    now; what changed is that selecting something is no longer an event that
    re-frames. Refs are the whole of that distinction, and it is the fix for
    "clicking a node zooms out".
  */
  const focusRef = useRef(focusId);
  const pathRef = useRef(pathIds);
  focusRef.current = focusId;
  pathRef.current = pathIds;

  useEffect(() => {
    const focusNow = focusRef.current;
    const pathNow = pathRef.current;
    const before = previous.current;
    previous.current = expanded;
    /*
     * WHY did this run, and is it a reason to re-fit?
     *
     * Three causes reach this effect and only two of them are re-frames:
     *
     *   the BOX changed   mode, or the surface's width — the focus workspace
     *                     opening is the case W4 added `widthKey` for, and a
     *                     transform does not grow with its container, so this
     *                     must fit;
     *   an EXPANSION      the reader pressed `+n`. W4's rule: fit the subtree
     *                     that opened rather than the whole map;
     *   a SELECTION       `applySelection` calls `expansionsFor()`, which opens
     *                     whatever chain is needed to put the selected node on
     *                     screen. THIS is the user's complaint. The shape did
     *                     change, so the effect legitimately runs, and re-fitting
     *                     here is what threw away the zoom they had chosen.
     *
     * The first two re-fit. The third does not: the viewport is left exactly
     * where the reader put it and {@link RevealSelection} pans to the node if it
     * ended up off screen.
     */
    const explicit = expandWasExplicit.current;
    expandWasExplicit.current = false;
    const boxKey = `${mode}|${String(widthKey)}`;
    const boxChanged = lastBox.current !== boxKey;
    lastBox.current = boxKey;
    lastLayout.current = layoutKey;
    /*
      Note what is NOT in this predicate: whether the layout key changed.
      Measured, and it is the second half of the same defect — selecting
      `servo.setServoAngle` re-runs this effect with an IDENTICAL node list,
      because `scope` is memoised on `focusId` and produces a new object for the
      same nodes. Requiring a shape change here let that run fall through to the
      fit, and the zoom went 1.44 -> 1.33 -> 1.00 in the one representation
      whose floor is its whole point. What decides is the CAUSE, not the diff.
    */
    const selectionOnly = before !== null && !boxChanged && !explicit;
    const opened = before === null ? [] : [...expanded].filter((id) => !before.has(id));
    const focus: string | null = opened.length === 1 ? (opened[0] as string) : null;
    // Two frames: React Flow measures nodes after paint, and fitting against
    // unmeasured nodes lands the viewport somewhere arbitrary.
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (mode === 'subsystem') {
          // Same rule as the full graph below: a selection re-frames nothing.
          // The subsystem's zoom is pinned to 1 either way, so what this
          // prevents is the viewport jumping while the reader reads.
          if (selectionOnly) return;
          // The focus, what it leads to, and what led TO it. The predecessor is
          // what makes the frame answer a question rather than centre a box:
          // for `R1` it brings `MG90S` into view, which is "which servo drives
          // this joint" - and it is the hand-authored edge, so the frame that
          // teaches is also the frame that shows where the evidence stops.
          /*
           * The CHAIN, not just the predecessor — Phase 4 W7 widens W4's frame.
           *
           * W4 framed the focus and the one node before it, because a 351 px
           * pane could hold about that much. The module column is half the
           * content area now, and framing three boxes in a 750 x 490 canvas
           * left most of it empty — a bigger box showing the same small
           * picture, which is the failure W4 itself named when it added
           * `widthKey`. The causal path is what the extra room is for: it is
           * the same question ("what led to this") answered further back.
           */
          const around = [
            ...pathNow,
            focusNow,
            ...childrenOf(focusNow).map((c) => c.id),
          ].filter((n) => visibleIds.includes(n));
          /*
           * If the whole neighbourhood FITS at zoom 1, frame the whole
           * neighbourhood — Phase 4 W7.
           *
           * W4 framed on the focus and its predecessor because the pane was
           * 351 px wide and a handful of boxes was all that could be on screen.
           * The module column gives the architecture half the content area now,
           * and at 1920x1080 that frame centred four boxes in a 750 px canvas
           * and left half of it empty. So the frame is chosen by measurement
           * rather than by rule: the scoped subsystem's own bounding box
           * against the canvas, both in model pixels because the zoom is
           * pinned to 1. When it does not fit, W4's frame is still the right
           * one and is still what is used — the focus and what led to it,
           * which is the frame that teaches.
           */
          const canvasBox = document
            .querySelector('[data-testid="arch-canvas"]')
            ?.getBoundingClientRect();
          const placed = flow.getNodes().filter((n) => visibleIds.includes(n.id));
          const spans = (get: (n: (typeof placed)[number]) => readonly [number, number]): number => {
            const lows = placed.map((n) => get(n)[0]);
            const highs = placed.map((n) => get(n)[1]);
            return Math.max(...highs) - Math.min(...lows);
          };
          const fitsWhole =
            canvasBox !== undefined &&
            placed.length > 0 &&
            spans((n) => [n.position.x, n.position.x + (n.measured?.width ?? 220)]) <=
              canvasBox.width * 0.88 &&
            spans((n) => [n.position.y, n.position.y + (n.measured?.height ?? 72)]) <=
              canvasBox.height * 0.88;
          const nodes = fitsWhole ? visibleIds : around.length > 0 ? around : visibleIds.slice(0, 4);
          void flow
            .fitView({
              nodes: nodes.map((n) => ({ id: n })),
              padding: 0.12,
              minZoom: 1,
              maxZoom: 1,
              // W6: 0 ms under prefers-reduced-motion. React Flow tweens the
              // viewport transform in JavaScript, so no CSS rule reaches it.
              duration: motionDurationMs(200),
            })
            /*
             * THE ZOOM FLOOR, enforced rather than requested — Phase 4 W7.
             *
             * `minZoom: 1` in `fitViewOptions` and `minZoom={1}` on the
             * component are both true and neither is sufficient: W7's ordinary
             * layout is the first arrangement that mounts the subsystem view at
             * a width the harness visits, and it caught the graph drawn at
             * **0.929** — 14.4 px edge labels at 13.38 px on screen — after a
             * remount at a width React Flow had not measured yet. A fit that
             * lands below the floor is a fit that has silently traded the one
             * property this representation exists to have: at zoom 1 the
             * AUTHORED size is the size on screen, so the 14 px floor is
             * asserted against what is drawn with no exemption at all.
             *
             * The reader can still pan — the surface is a declared
             * `data-2d-surface` — which is the trade the subsystem view makes
             * on purpose: scoped nodes at a legible size, panned, rather than
             * all of them shrunk.
             */
            .then(() => {
              if (flow.getZoom() < 1) void flow.zoomTo(1, { duration: 0 });
            });
          return;
        }
        /*
         * The fix, in one branch — Phase 4 W8.
         *
         * > *"when I click on a node, it zooms out and I need to keep manually
         * > zooming in."*
         *
         * Measured before this: zoom 0.501 -> 0.348 on a single click, because
         * selecting `movement` expanded the chain to it and the effect fell
         * through to the whole-graph `fitView` below.
         */
        if (selectionOnly) return;
        if (focus !== null) {
          const subtree = [focus, ...childrenOf(focus).map((c) => c.id)].filter((n) =>
            visibleIds.includes(n),
          );
          void flow.fitView({ nodes: subtree.map((n) => ({ id: n })), padding: 0.2, duration: motionDurationMs(260) });
          return;
        }
        void flow.fitView({ padding: 0.16, duration: motionDurationMs(260) });
      }),
    );
    return () => cancelAnimationFrame(id);
    /*
      `layoutKey` is what actually changed; `expanded` is read for the diff.

      **`focusId` and `pathIds` are deliberately NOT here.** They are read from
      refs above. A selection changes both of them, and having them in this list
      is what made a node click re-fit the whole 63-node graph — the defect the
      user reported. React's exhaustive-deps rule would put them back; the
      disable is the point rather than an oversight.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, mode, layoutKey, expanded, visibleIds, widthKey, expandWasExplicit]);

  return null;
}

/**
 * Answer a SELECTION by panning, never by zooming — Phase 4 W8.
 *
 * > *"when I click on a node, it zooms out and I need to keep manually zooming
 * > in."*
 *
 * The rule this implements is narrow and is asserted as stated: **the zoom does
 * not decrease across a node click, in either representation that has a
 * viewport.** So:
 *
 *  - the current zoom is read off React Flow and handed straight back to
 *    `setCenter`, which is the one API here that takes a zoom rather than
 *    computing one. `fitView` computes one, which is why it is not used;
 *  - and the pan happens ONLY when the selected node is outside the canvas, so
 *    clicking a box that is already on screen moves nothing at all. A viewport
 *    that recentres on every click is its own kind of unusable.
 *
 * `w` and `h` come from React Flow's own store rather than from a DOM
 * measurement, so "is this node on screen" is asked in the same coordinate
 * space the library places nodes in.
 */

function RevealSelection({
  mode,
  focusId,
  visibleIds,
}: {
  readonly mode: ArchitectureMode;
  readonly focusId: string;
  readonly visibleIds: readonly string[];
}): null {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  /**
   * The focus this effect last answered.
   *
   * It exists so the effect fires on a SELECTION and on nothing else. Its
   * dependency list also holds `visibleIds`, which changes whenever the layout
   * does — and answering a layout change here would race `Reframe`'s own
   * animated `fitView`, read a zoom mid-flight and freeze the graph at it. That
   * is not hypothetical: it is how the subsystem view came out at 0.917 with
   * 13.21 px labels, in a representation whose whole claim is a zoom floor of 1.
   */
  const answered = useRef<string | null>(null);

  useEffect(() => {
    if (!visibleIds.includes(focusId)) return;
    if (width < 1 || height < 1) return;
    // The first run is the mount, and `fitView` owns the mount.
    if (answered.current === focusId) return;
    const first = answered.current === null;
    answered.current = focusId;
    if (first) return;
    // One frame: a selection can arrive in the same commit that mounted the
    // node, and an unmeasured node has no position worth panning to.
    const raf = requestAnimationFrame(() => {
      const node = flow.getNode(focusId);
      if (node === undefined) return;
      /*
        The zoom in force, and never below this representation's own floor.
        `setCenter` takes a zoom and applies it exactly, so handing it a value
        read mid-animation would PIN the graph there — which is how a pan
        turned into a zoom-out in the one view that is not allowed one.
      */
      const zoom = Math.max(flow.getZoom(), mode === 'subsystem' ? 1 : 0);
      const viewport = flow.getViewport();
      const nodeW = node.measured?.width ?? 220;
      const nodeH = node.measured?.height ?? 72;
      const cx = node.position.x + nodeW / 2;
      const cy = node.position.y + nodeH / 2;
      // Where that centre currently is, in canvas pixels.
      const sx = cx * zoom + viewport.x;
      const sy = cy * zoom + viewport.y;
      const insetX = Math.min(width / 3, (nodeW * zoom) / 2 + 16);
      const insetY = Math.min(height / 3, (nodeH * zoom) / 2 + 16);
      const onScreen =
        sx >= insetX && sx <= width - insetX && sy >= insetY && sy <= height - insetY;
      if (onScreen) return;
      // The zoom that is in force, handed back unchanged. This is the whole fix.
      void flow.setCenter(cx, cy, { zoom, duration: motionDurationMs(200) });
    });
    return () => cancelAnimationFrame(raf);
  }, [flow, mode, focusId, visibleIds, width, height]);

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

  /*
   * Did the READER expand something, or did a selection do it for them?
   *
   * `applySelection` calls `expansionsFor()` and opens whatever chain is needed
   * to put the selected node on screen, so `expanded` grows on a plain node
   * click. Both paths end in the same `expanded` prop and the graph cannot tell
   * them apart from the value — so the one that came through a `+n` press says
   * so on the way past. See {@link Reframe}.
   */
  const expandWasExplicit = useRef(false);
  const handleToggle = useCallback(
    (id: string) => {
      expandWasExplicit.current = true;
      onToggle(id);
    },
    [onToggle],
  );

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
          onToggle: handleToggle,
        },
      })),
    [layout, selection, activeNodeIds, handleToggle, mode, metrics],
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
        <h2 className="panel-title-echo">Architecture</h2>
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
                expandWasExplicit={expandWasExplicit}
              />
              {/*
                Selection is answered here and nowhere else, and it may only
                pan. See {@link RevealSelection}.
              */}
              <RevealSelection mode={mode} focusId={focusId} visibleIds={visibleIds} />
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
