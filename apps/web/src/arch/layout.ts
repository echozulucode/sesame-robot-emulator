/**
 * Turning the generated graph into something React Flow can draw.
 *
 * Two jobs, both of which have to be deterministic — the headless harness reads
 * node ids and positions back, and a layout that shuffles between runs would
 * make every screenshot comparison meaningless.
 *
 * 1. **Visibility.** A node is visible when every one of its ancestors is
 *    expanded. Collapsed, that leaves exactly the nine nodes the research
 *    report's tree draws.
 * 2. **Edge lifting.** Edges are stored once, on the *real* chain
 *    (`servo.gpio → servo.mg90s`), never duplicated per collapse state. At draw
 *    time each endpoint is lifted to its nearest visible ancestor and self-edges
 *    are dropped. That is what makes `Movement → 8 Servos` appear when `Servos`
 *    is collapsed and `setServoAngle → ESP32Servo → LEDC → …` appear when it is
 *    not, from one edge list. There is no second diagram.
 */
import {
  ARCH_EDGES,
  ARCH_NODES,
  ARCH_NODE_BY_ID,
  GROUP_ORDER,
  type ArchEdge,
  type ArchNode,
} from '../generated/architecture-graph.js';

/*
 * Phase 4 W1 grew these.
 *
 * They were 124x46 with 62 px rows, which fitted a 12px label over a 9px
 * summary and nothing larger. At the brief's floor — 15px for the label, 14px
 * for the summary, three lines of it — the old box clipped both, and the fix
 * for clipped text is never to put the type back.
 */
export const NODE_W = 192;
export const NODE_H = 112;
const GAP_X = 14;
const GAP_GROUP = 56;

/**
 * The box the FULL graph draws — Phase 4 W1's numbers, unchanged.
 *
 * A second set exists because W4's subsystem representation locks the zoom at
 * 1 (a 14 px edge label at zoom 1 is a 14 px edge label on screen), and a
 * 112 px box with three lines of summary makes a nine-row chain 1,224 px tall
 * before anything is drawn. The subsystem box keeps every token size and
 * spends the SUMMARY's third and second lines instead, which is the one thing
 * in it that is a repeat of the detail panel below.
 */
export interface LayoutMetrics {
  readonly nodeW: number;
  readonly nodeH: number;
  readonly rowH: number;
  readonly maxPerRow: number;
}

export const FULL_METRICS: LayoutMetrics = Object.freeze({
  nodeW: 192,
  nodeH: 112,
  rowH: 136,
  maxPerRow: 4,
});

export const SUBSYSTEM_METRICS: LayoutMetrics = Object.freeze({
  nodeW: 192,
  nodeH: 74,
  rowH: 98,
  maxPerRow: 4,
});

export interface LayoutOptions {
  /**
   * Draw exactly these node ids, ignoring the expand/collapse state.
   *
   * W4's subsystem representation. Expansion is the FULL graph's affordance:
   * a subsystem view whose subsystem happened to be collapsed would draw two
   * boxes and call itself a neighbourhood.
   */
  readonly scope?: ReadonlySet<string>;
  readonly metrics?: LayoutMetrics;
}
export interface PlacedNode {
  readonly node: ArchNode;
  readonly x: number;
  readonly y: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** How many descendants a click would reveal. Shown on the badge. */
  readonly hiddenChildren: number;
}

export interface LiftedEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string | null;
  /** True when either endpoint was lifted, i.e. the edge is a collapsed proxy. */
  readonly lifted: boolean;
  readonly derivation: ArchEdge['derivation'];
  readonly derivedFrom: string;
}

export interface ArchLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly LiftedEdge[];
}

const CHILDREN: ReadonlyMap<string, readonly ArchNode[]> = (() => {
  const m = new Map<string, ArchNode[]>();
  for (const n of ARCH_NODES) {
    if (n.parent === null) continue;
    const bucket = m.get(n.parent);
    if (bucket === undefined) m.set(n.parent, [n]);
    else bucket.push(n);
  }
  return m;
})();

export function childrenOf(id: string): readonly ArchNode[] {
  return CHILDREN.get(id) ?? [];
}

export function isExpandable(id: string): boolean {
  return CHILDREN.has(id);
}

/** Every ancestor of `id`, nearest first. Empty for a root node. */
export function ancestorsOf(id: string): readonly string[] {
  const out: string[] = [];
  let cursor = ARCH_NODE_BY_ID.get(id)?.parent ?? null;
  while (cursor !== null) {
    out.push(cursor);
    cursor = ARCH_NODE_BY_ID.get(cursor)?.parent ?? null;
  }
  return out;
}

/** What must be expanded for `id` to be on screen. */
export function expansionsFor(id: string): readonly string[] {
  return ancestorsOf(id);
}

export function isVisible(node: ArchNode, expanded: ReadonlySet<string>): boolean {
  return ancestorsOf(node.id).every((a) => expanded.has(a));
}

/** Nearest ancestor of `id` (or `id` itself) that is currently drawn. */
function liftToVisible(id: string, visible: ReadonlySet<string>): string | null {
  if (visible.has(id)) return id;
  for (const ancestor of ancestorsOf(id)) if (visible.has(ancestor)) return ancestor;
  return null;
}

/**
 * Place every visible node.
 *
 * One column per top-level branch, ordered by `GROUP_ORDER`; within a column,
 * one row per `depth`, wrapped at `MAX_PER_ROW`. Column widths are measured
 * rather than assumed, so expanding the 21 movement functions pushes `Face`,
 * `Network` and `Serial` right instead of drawing on top of them.
 */
export function layoutArchitecture(
  expanded: ReadonlySet<string>,
  options: LayoutOptions = {},
): ArchLayout {
  const scope = options.scope;
  const nodeW = options.metrics?.nodeW ?? FULL_METRICS.nodeW;
  const rowH = options.metrics?.rowH ?? FULL_METRICS.rowH;
  const maxPerRow = options.metrics?.maxPerRow ?? FULL_METRICS.maxPerRow;
  const visibleNodes =
    scope === undefined
      ? ARCH_NODES.filter((n) => isVisible(n, expanded))
      : ARCH_NODES.filter((n) => scope.has(n.id));
  const visibleIds = new Set(visibleNodes.map((n) => n.id));

  // ---- group -> ordered rows (chunked by MAX_PER_ROW), and each group's width
  const rowsByGroup = new Map<string, ArchNode[][]>();
  for (const group of GROUP_ORDER) {
    const members = visibleNodes.filter((n) => n.group === group);
    const byDepth = new Map<number, ArchNode[]>();
    for (const n of members) {
      const bucket = byDepth.get(n.depth);
      if (bucket === undefined) byDepth.set(n.depth, [n]);
      else bucket.push(n);
    }
    const rows: ArchNode[][] = [];
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const row = byDepth.get(depth) as ArchNode[];
      for (let i = 0; i < row.length; i += maxPerRow) rows.push(row.slice(i, i + maxPerRow));
    }
    rowsByGroup.set(group, rows);
  }

  const rowWidth = (n: number): number => n * nodeW + (n - 1) * GAP_X;
  const groupWidth = (group: string): number =>
    Math.max(nodeW, ...(rowsByGroup.get(group) ?? [[]]).map((r) => rowWidth(r.length)));

  const placed: PlacedNode[] = [];
  const place = (node: ArchNode, x: number, y: number): void => {
    const kids = childrenOf(node.id);
    placed.push({
      node,
      x,
      y,
      expandable: kids.length > 0,
      expanded: expanded.has(node.id),
      hiddenChildren: expanded.has(node.id) ? 0 : kids.length,
    });
  };

  let cursor = 0;
  const centres: number[] = [];
  for (const group of GROUP_ORDER) {
    const width = groupWidth(group);
    const centre = cursor + width / 2;
    centres.push(centre);
    const rows = rowsByGroup.get(group) ?? [];
    rows.forEach((row, rowIndex) => {
      const left = centre - rowWidth(row.length) / 2;
      row.forEach((node, i) => place(node, left + i * (nodeW + GAP_X), (rowIndex + 1) * rowH));
    });
    cursor += width + GAP_GROUP;
  }

  // The root sits above and centred over the four branches.
  const root = visibleNodes.find((n) => n.group === 'root');
  if (root !== undefined) {
    const mid = centres.length === 0 ? 0 : (Math.min(...centres) + Math.max(...centres)) / 2;
    place(root, mid - nodeW / 2, 0);
  }

  // ---- lift edges to the visible frontier, dedupe, drop self-loops
  const seen = new Map<string, LiftedEdge>();
  for (const e of ARCH_EDGES) {
    const source = liftToVisible(e.source, visibleIds);
    const target = liftToVisible(e.target, visibleIds);
    if (source === null || target === null || source === target) continue;
    const lifted = source !== e.source || target !== e.target;
    const id = `${source}->${target}`;
    const existing = seen.get(id);
    if (existing !== undefined) {
      // A lifted edge that collapses several real ones keeps the first label
      // and stops claiming to be a single derivation.
      if (existing.derivedFrom !== e.derivedFrom) {
        seen.set(id, { ...existing, derivedFrom: `${existing.derivedFrom} (+more)`, lifted: true });
      }
      continue;
    }
    seen.set(id, {
      id,
      source,
      target,
      label: lifted ? null : e.label,
      lifted,
      derivation: e.derivation,
      derivedFrom: e.derivedFrom,
    });
  }

  return { nodes: placed, edges: [...seen.values()] };
}
