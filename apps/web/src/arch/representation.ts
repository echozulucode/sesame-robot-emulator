/**
 * Which ARTIFACT the architecture pane draws — Phase 4 W4.
 *
 * The complaint this exists to close is the user's own, and it survived three
 * layout iterations:
 *
 * > *"the architecture pane is so tiny that it is unusable on medium screens."*
 *
 * W1 measured it getting worse rather than better: node labels 9.0 -> 8.0 px at
 * 1440 and 4.2 -> 3.8 px at 880, on a surface already three to six times below
 * the 14 px floor. There is no type size that fixes that. The brief's answer is
 * not a smaller graph, it is a **different artifact**:
 *
 * | pane width | representation | scope |
 * |---:|---|---|
 * | `< 720` | causal path / scoped navigator | the current path + nearby branches |
 * | `720-959` | subsystem graph | one neighbourhood, 10-18 nodes |
 * | `>= 960` | full graph | all 63 nodes |
 * | explicit action | focus workspace | the full graph with room to navigate |
 *
 * > *"This is not 'dumbing down' the graph. It is changing from an overview
 * > task to a tracing task, which is exactly what the product says it is
 * > trying to teach."*
 *
 * ## Why these thresholds are not {@link PANE_BANDS}
 *
 * W2 built `ui/use-container-width.ts` with a **generic** pane table — 520 and
 * 720 — mirrored one-for-one by the two `@container` thresholds in
 * `styles.css`, and the harness fails statically if a third appears there. That
 * table answers "does this pane have room for two columns", and four panes
 * share it.
 *
 * The numbers below answer a different question — "does this pane have room for
 * *this diagram*" — and the brief derives them from the artifact rather than
 * from the column count: 63 nodes and 65 edges need 960, one neighbourhood of
 * 10-18 needs 720, and below that a spatial diagram stops being a diagram. They
 * are not the same rule and forcing them into one table would either add a
 * third generic threshold (which W2 forbids, and which is how a responsive
 * system becomes forty unrelated numbers) or move the Inspector's table and the
 * Signal row to 720/960 for a reason that has nothing to do with them.
 *
 * So there are two tables, deliberately, and the relationship between them is
 * stated rather than implied: **{@link PANE_BANDS} is about columns and is read
 * by CSS; {@link ARCH_BANDS} is about this one artifact and is read by React.**
 * `paneWidthBand()` keeps describing the Modules pane's chrome (W2 asserts
 * `data-pane-band` against it, and that assertion is untouched); this module
 * decides what is mounted inside it.
 *
 * ## Measured on the canvas, not on the pane
 *
 * W2's asymmetry is kept: the width branched on is the **artifact's own box**,
 * about 40-50 px narrower than the pane's content box. That is conservative in
 * the direction that matters — the invariant is "the 63-node graph is not
 * mounted below 720 px of container", and a canvas of 720 px only ever happens
 * inside a pane wider than that, so measuring the smaller box can only make the
 * representation *more* scoped than the rule requires, never less.
 */
import {
  ARCH_EDGES,
  ARCH_NODES,
  ARCH_NODE_BY_ID,
  GROUP_ORDER,
  type ArchDerivation,
  type ArchNode,
} from '../generated/architecture-graph.js';
import { ancestorsOf, childrenOf } from './layout.js';

/** The three artifacts, in order of how much of the model they show. */
export type ArchitectureMode = 'path' | 'subsystem' | 'full';

/**
 * The brief's thresholds, in CSS pixels of the graph's own box.
 *
 * Written as the same shape as `PANE_BANDS` so the two tables can be read side
 * by side, and deliberately NOT merged with it — see the module comment.
 */
export const ARCH_BANDS = Object.freeze({ path: 0, subsystem: 720, full: 960 });

/**
 * The brief's `modeForWidth`, verbatim:
 *
 * ```tsx
 * function modeForWidth(width: number): ArchitectureMode {
 *   if (width < 720) return 'path';
 *   if (width < 960) return 'subsystem';
 *   return 'full';
 * }
 * ```
 *
 * Total, and defined at 0 and at NaN: an unmeasured box is not a wide one.
 */
export function archModeForWidth(widthPx: number): ArchitectureMode {
  if (!Number.isFinite(widthPx) || widthPx < ARCH_BANDS.subsystem) return 'path';
  return widthPx < ARCH_BANDS.full ? 'subsystem' : 'full';
}

/**
 * The subsystem view's node budget.
 *
 * > *"A Movement view might show 10-18 relevant nodes and their local edges.
 * > The exact node cap is a product rule, not a published usability threshold;
 * > the principle is to prevent 'Fit View' from shrinking labels until
 * > technically everything fits but cognitively nothing is usable."*
 *
 * So it is a product rule, and it is enforced rather than hoped for: what does
 * not fit is COUNTED and named on screen, never silently dropped.
 */
export const ARCH_SUBSYSTEM_MAX_NODES = 18;

/**
 * Where the causal path starts when nothing is selected and nothing has run.
 *
 * The chain the product exists to teach, ending at the part no artefact in this
 * repository describes — which is the honest place for a first look to stop.
 */
export const DEFAULT_FOCUS_NODE_ID = 'servo.mg90s';

// --------------------------------------------------------------- adjacency

interface OutEdge {
  readonly target: string;
  readonly label: string | null;
  readonly derivation: ArchDerivation;
  readonly derivedFrom: string;
}

const OUT: ReadonlyMap<string, readonly OutEdge[]> = (() => {
  const m = new Map<string, OutEdge[]>();
  for (const e of ARCH_EDGES) {
    const bucket = m.get(e.source);
    const edge: OutEdge = {
      target: e.target,
      label: e.label,
      derivation: e.derivation,
      derivedFrom: e.derivedFrom,
    };
    if (bucket === undefined) m.set(e.source, [edge]);
    else bucket.push(edge);
  }
  return m;
})();

const ROOT_ID = 'esp32';

/** Every edge out of `id`, in generator order. */
export function outEdgesOf(id: string): readonly OutEdge[] {
  return OUT.get(id) ?? [];
}

// ------------------------------------------------------------ the subsystem

export interface Subsystem {
  readonly id: string;
  readonly label: string;
  readonly totalNodes: number;
}

/**
 * The four branches under `setup()`, named by their own depth-1 node.
 *
 * `GROUP_ORDER` is generated; the labels are the generated nodes' own labels.
 * Nothing here is a second taxonomy.
 */
export const SUBSYSTEMS: readonly Subsystem[] = GROUP_ORDER.map((group) => ({
  id: group,
  label: ARCH_NODES.find((n) => n.group === group && n.depth === 1)?.label ?? group,
  totalNodes: ARCH_NODES.filter((n) => n.group === group).length,
}));

const SUBSYSTEM_IDS: readonly string[] = SUBSYSTEMS.map((s) => s.id);

/** Which subsystem a node belongs to. The root belongs to none. */
export function subsystemForNode(nodeId: string | null): string | null {
  if (nodeId === null) return null;
  const group = ARCH_NODE_BY_ID.get(nodeId)?.group ?? null;
  return group !== null && SUBSYSTEM_IDS.includes(group) ? group : null;
}

// ------------------------------------------------------------- the focus

/**
 * The node the scoped representations are *about*.
 *
 * In order: what the reader selected, then the deepest node the current trace
 * lit, then the default chain. The middle rule is what makes a `wave` open the
 * pane on the wave's own path rather than on a fixed diagram — the narrow view
 * is a tracing task, and a tracing task has to know what is being traced.
 */
export function focusNodeFor(
  selectedNodeId: string | null,
  activeNodeIds: ReadonlySet<string>,
): string {
  if (selectedNodeId !== null && ARCH_NODE_BY_ID.has(selectedNodeId)) return selectedNodeId;
  let deepest: ArchNode | null = null;
  for (const node of ARCH_NODES) {
    if (!activeNodeIds.has(node.id)) continue;
    if (deepest === null || node.depth > deepest.depth) deepest = node;
  }
  return deepest?.id ?? DEFAULT_FOCUS_NODE_ID;
}

// -------------------------------------------------------- the causal path

export interface PathStep {
  readonly node: ArchNode;
  /** The edge that reaches this step from the one above. `null` at the root. */
  readonly via: {
    readonly label: string | null;
    readonly derivation: ArchDerivation;
    readonly derivedFrom: string;
  } | null;
  /** Out-edges from this step that the path does NOT take, first {@link PATH_BRANCHES_SHOWN}. */
  readonly branches: readonly ArchNode[];
  /** All of them. `+N more` opens the rest in place, so nothing is unreachable. */
  readonly allBranches: readonly ArchNode[];
  /** Branches beyond the ones listed by default, counted rather than hidden. */
  readonly branchesOmitted: number;
}

export interface CausalPath {
  readonly focusId: string;
  readonly steps: readonly PathStep[];
  /** Ids on the path, for `is-on-path` styling and for the harness. */
  readonly nodeIds: readonly string[];
}

/** How many sibling branches a step lists before it starts counting them. */
export const PATH_BRANCHES_SHOWN = 3;

/**
 * The shortest edge path from `ESP32` to the focus node.
 *
 * Breadth-first over {@link ARCH_EDGES}, with **active targets tried first** so
 * that when two routes are equally short the one the current trace actually lit
 * is the one drawn. The graph is a tree plus three cross-links, so in practice
 * the path is unique; the ordering matters for the cross-links
 * (`route.5 -> movement`, `serial.cli -> movement`, `setServoAngle -> face`),
 * where "which way did this command come in" is a real question with a real
 * answer in the trace.
 *
 * Returns the root alone if the focus is unreachable, which is what an id that
 * is not in the generated graph produces — see `hardware/lessons.json`'s
 * `graph-node-picker` target `i2c`, which is not a node id.
 */
export function causalPath(focusId: string, activeNodeIds: ReadonlySet<string>): CausalPath {
  const target = ARCH_NODE_BY_ID.has(focusId) ? focusId : ROOT_ID;
  const cameFrom = new Map<string, { from: string; via: OutEdge }>();
  const seen = new Set<string>([ROOT_ID]);
  const queue: string[] = [ROOT_ID];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === target) break;
    const edges = [...outEdgesOf(id)].sort((a, b) => {
      const aActive = activeNodeIds.has(a.target) ? 0 : 1;
      const bActive = activeNodeIds.has(b.target) ? 0 : 1;
      return aActive - bActive;
    });
    for (const edge of edges) {
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      cameFrom.set(edge.target, { from: id, via: edge });
      queue.push(edge.target);
    }
  }

  const chain: string[] = [];
  let cursor: string | undefined = target;
  const guard = new Set<string>();
  while (cursor !== undefined && !guard.has(cursor)) {
    guard.add(cursor);
    chain.unshift(cursor);
    cursor = cameFrom.get(cursor)?.from;
  }
  if (chain[0] !== ROOT_ID) chain.unshift(ROOT_ID);

  const onPath = new Set(chain);
  const steps: PathStep[] = chain.flatMap((id, index) => {
    const node = ARCH_NODE_BY_ID.get(id);
    if (node === undefined) return [];
    const inbound = cameFrom.get(id);
    const nextId = chain[index + 1];
    const siblings = outEdgesOf(id)
      .filter((e) => e.target !== nextId && !onPath.has(e.target))
      .map((e) => ARCH_NODE_BY_ID.get(e.target))
      .filter((n): n is ArchNode => n !== undefined);
    // Active branches first: after a `wave`, `wave()` is the branch off
    // `Movement` a reader is looking for, and it is not first in enum order.
    const ordered = [...siblings].sort((a, b) => {
      const aActive = activeNodeIds.has(a.id) ? 0 : 1;
      const bActive = activeNodeIds.has(b.id) ? 0 : 1;
      return aActive - bActive;
    });
    return [
      {
        node,
        via:
          inbound === undefined
            ? null
            : {
                label: inbound.via.label,
                derivation: inbound.via.derivation,
                derivedFrom: inbound.via.derivedFrom,
              },
        branches: ordered.slice(0, PATH_BRANCHES_SHOWN),
        allBranches: ordered,
        branchesOmitted: Math.max(0, ordered.length - PATH_BRANCHES_SHOWN),
      },
    ];
  });

  return { focusId: target, steps, nodeIds: steps.map((s) => s.node.id) };
}

// ---------------------------------------------------------- the subsystem

export interface SubsystemScope {
  readonly subsystem: string;
  readonly ids: ReadonlySet<string>;
  /** Nodes of this subsystem the budget could not take. Named on screen. */
  readonly omitted: number;
  /** Every node in the subsystem, budget or not. */
  readonly total: number;
}

/**
 * One meaningful neighbourhood: the chain to the focus, plus whole sibling
 * sets, up to {@link ARCH_SUBSYSTEM_MAX_NODES}.
 *
 * **Whole sets or none.** A parent's children are added only if all of them
 * fit, so the view never shows "R1, R2 and 6 more joints" as though six joints
 * were less real than two. For `Movement` focused anywhere on the servo chain
 * that is 8 chain nodes plus the 8 joints — 16 — and the 21 movement functions
 * are counted as omitted rather than sampled.
 *
 * Deliberately independent of the expand/collapse state. Expansion is the FULL
 * graph's affordance; a subsystem view whose subsystem was collapsed would draw
 * two boxes and call itself a neighbourhood.
 */
export function subsystemScope(subsystem: string, focusId: string): SubsystemScope {
  const members = ARCH_NODES.filter((n) => n.group === subsystem);
  const memberIds = new Set(members.map((n) => n.id));
  const picked = new Set<string>([ROOT_ID]);

  // The chain from the root to the focus, as far as it lies in this subsystem.
  const focusNode = ARCH_NODE_BY_ID.get(focusId);
  const chain =
    focusNode !== undefined && focusNode.group === subsystem
      ? causalPath(focusId, new Set<string>()).nodeIds
      : [];
  for (const id of chain) if (memberIds.has(id)) picked.add(id);

  // The subsystem's own spine, so an unfocused view is still a neighbourhood.
  for (const node of members) {
    if (node.parent === null) picked.add(node.id);
  }

  // Then whole sibling sets, deepest parent first, while they fit.
  const parents = [...picked]
    .map((id) => ARCH_NODE_BY_ID.get(id))
    .filter((n): n is ArchNode => n !== undefined)
    .sort((a, b) => b.depth - a.depth || ARCH_NODES.indexOf(a) - ARCH_NODES.indexOf(b));
  for (const parent of parents) {
    const kids = childrenOf(parent.id).filter((k) => k.group === subsystem && !picked.has(k.id));
    if (kids.length === 0) continue;
    if (picked.size + kids.length > ARCH_SUBSYSTEM_MAX_NODES) continue;
    for (const kid of kids) picked.add(kid.id);
  }

  const shown = members.filter((n) => picked.has(n.id)).length;
  return { subsystem, ids: picked, omitted: members.length - shown, total: members.length };
}

/**
 * What the FULL representation needs expanded for the focus to be on screen.
 *
 * Re-exported here so the graph component has one import for representation
 * questions rather than reaching into the layout module for one function.
 */
export function expansionsForFocus(focusId: string): readonly string[] {
  return ancestorsOf(focusId);
}
