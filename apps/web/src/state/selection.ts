/**
 * One selection, four panes.
 *
 * The research report is explicit that cross-pane highlighting is worth more
 * than decorative gamification:
 *
 * ```text
 * click R4 in 3D  ↔  highlight R4 in the architecture graph
 *                 ↔  show the trace rows that touched R4
 *                 ↔  show R4 in the inspector
 *                 ↔  scroll the source pane to the line that names R4
 * ```
 *
 * The only way that stays true as panes are added is if there is exactly one
 * selection object and every pane both writes it and reads it. So this module
 * owns the concept, and nothing else is allowed to keep a private "selected"
 * of its own.
 *
 * ## The shape, and why it has three fields rather than one
 *
 * A selection has a **joint** and a **graph node**, and they are not the same
 * thing. Clicking `R4` in the 3D scene selects a joint, and the graph node
 * `joint.R4` follows. Clicking `LEDC / PWM` in the graph selects a node that is
 * about all eight joints and therefore highlights no single one — collapsing
 * that to "the joint is null" would be right, but collapsing it to "pick the
 * first joint" would be a lie the 3D scene would then render.
 *
 * The source pane adds a **symbol** for the same reason, and it is the same
 * argument once more: 63 architecture nodes sit inside 90 annotated symbols, so
 * most symbols have no node, and folding the symbol into `nodeId` would make
 * two thirds of the source outline unselectable.
 *
 * `origin` records which pane initiated it. Panes use it for one thing only:
 * not to fight each other for scroll position.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';

import { ARCH_NODE_BY_ID, JOINT_FACTS } from '../generated/architecture-graph.js';
import { expansionsFor } from '../arch/layout.js';
import { archNodesInSymbol, symbolContains, SYMBOL_BY_ID, symbolForNode } from '../source/model.js';

export type SelectionOrigin = 'scene' | 'graph' | 'trace' | 'inspector' | 'source';

export interface SelectionState {
  /** Which pane set it. `null` only for the empty selection. */
  readonly origin: SelectionOrigin | null;
  /** The joint this selection is about, or `null` when it is about no one joint. */
  readonly joint: JointName | null;
  /** The architecture node this selection is about, or `null`. */
  readonly nodeId: string | null;
  /**
   * The annotated source symbol this selection is about, or `null`.
   *
   * A third field rather than a fifth pane keeping its own state, for exactly
   * the reason the two above are here. It cannot be derived from `nodeId`,
   * because the two sets are not in bijection: 63 architecture nodes land
   * inside 90 annotated symbols, so most symbols have no node at all
   * (`setFace`, `delayWithFace`, `handleSetSettings`) and clicking one would
   * otherwise have nothing to hold on to. Where a node *does* exist it is
   * resolved here, once, by line containment.
   */
  readonly symbolId: string | null;
}

export const EMPTY_SELECTION: SelectionState = Object.freeze({
  origin: null,
  joint: null,
  nodeId: null,
  symbolId: null,
});

const isJointName = (value: string): value is JointName =>
  (JOINT_ORDER as readonly string[]).includes(value);

/**
 * Select a joint. The graph node `joint.<name>` comes along for free — it is
 * generated from `servos.joints[]`, so it always exists for a real joint.
 */
export function selectJoint(joint: JointName | null, origin: SelectionOrigin): SelectionState {
  if (joint === null) return EMPTY_SELECTION;
  const nodeId = JOINT_FACTS[joint]?.nodeId ?? `joint.${joint}`;
  // The source pane follows through the node's own citation. For `joint.R4`
  // that is `movement-sequences.h:10`, the enum line hardware-map.json cites
  // for R4, which sits inside `ServoName` — a symbol whose `robotParts`
  // contains R4. So "click a leg, see the line that names it" is containment,
  // not a lookup table.
  return { origin, joint, nodeId, symbolId: symbolForNode(nodeId)?.id ?? null };
}

/**
 * Select an architecture node.
 *
 * A node that is about exactly one joint also selects that joint, which is what
 * makes clicking `R4` in the graph light it up in the 3D scene. A node about
 * eight joints (`LEDC`, `setServoAngle`) selects none of them: it is about the
 * stage, not about a limb.
 */
export function selectNode(nodeId: string | null, origin: SelectionOrigin): SelectionState {
  if (nodeId === null) return EMPTY_SELECTION;
  const node = ARCH_NODE_BY_ID.get(nodeId);
  const joints = node?.joints ?? [];
  const only = joints.length === 1 ? joints[0] : undefined;
  return {
    origin,
    joint: only !== undefined && isJointName(only) ? only : null,
    nodeId,
    symbolId: symbolForNode(nodeId)?.id ?? null,
  };
}

/**
 * Select an annotated source symbol.
 *
 * The reverse of {@link selectNode}, and asymmetric on purpose. A node has
 * exactly one `sourceRef`, so it resolves to exactly one symbol. A symbol can
 * contain several nodes' citations — `ServoName` contains nine, the eight
 * joints plus `servos` — and picking one of the nine would be a guess presented
 * as an answer. So when the citation is ambiguous, `nodeId` stays `null` and
 * every node inside the symbol renders as *related* instead. The graph says
 * "these nine cite this code", which is true, rather than "this one", which is
 * not.
 */
export function selectSymbol(symbolId: string | null, origin: SelectionOrigin): SelectionState {
  if (symbolId === null) return EMPTY_SELECTION;
  if (!SYMBOL_BY_ID.has(symbolId)) return EMPTY_SELECTION;
  const nodes = archNodesInSymbol(symbolId);
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only === undefined) return { origin, joint: null, nodeId: null, symbolId };
  // Keep the symbol the learner clicked, not the one the node round-trips to:
  // selecting `loop` and landing on the nested `serial-cli` region would move
  // the pane out from under them.
  return { ...selectNode(only.id, origin), symbolId };
}

/** Is this symbol the selected one? */
export function symbolIsSelected(symbolId: string, selection: SelectionState): boolean {
  return selection.symbolId === symbolId;
}

/**
 * Which joints the 3D scene should light for this selection.
 *
 * One joint when the selection is about one joint. Otherwise the selected
 * symbol's `robotParts` — "the joints this span of code commands directly",
 * computed by L3 from `hardware-map.json` and already in firmware enum order.
 * That is what makes selecting `runWavePose` light R1, L2, R4 and L3 in
 * three.js and nothing else, which is the report's *“which line moved this
 * leg?”* answered in the opposite direction.
 *
 * Never re-sorted, and never widened to `robotPartsTransitive`: a wave reaches
 * all eight joints through its closing `runStandPose()`, and lighting all eight
 * would say the wave commands them, which it does not.
 */
export function litJointsFor(selection: SelectionState): readonly JointName[] {
  if (selection.joint !== null) return [selection.joint];
  const symbol = selection.symbolId === null ? undefined : SYMBOL_BY_ID.get(selection.symbolId);
  if (symbol === undefined) return [];
  return symbol.robotParts.filter(isJointName);
}

/** Nothing selected. */
export function isEmptySelection(selection: SelectionState): boolean {
  return selection.joint === null && selection.nodeId === null && selection.symbolId === null;
}

/**
 * What must be expanded for the selection to be on screen.
 *
 * Selecting `R4` in the 3D scene is useless if `Servos` is collapsed and the
 * `joint.R4` node is not drawn, so the graph auto-expands the chain. It only
 * ever *adds* expansions — a click in the 3D view must never collapse
 * something the learner deliberately opened.
 */
export function expansionsForSelection(selection: SelectionState): readonly string[] {
  return selection.nodeId === null ? [] : expansionsFor(selection.nodeId);
}

/** Should this graph node render as selected? */
export function nodeIsSelected(nodeId: string, selection: SelectionState): boolean {
  return selection.nodeId === nodeId;
}

/**
 * Should this graph node render as *related* to the selection?
 *
 * A joint selection lights every node that is about that joint — the whole
 * `setServoAngle → ESP32Servo → LEDC → GPIO → MG90S` chain — which is the
 * report's "show R4's firmware calls" made literal.
 */
export function nodeIsRelated(nodeId: string, selection: SelectionState): boolean {
  if (selection.nodeId === nodeId) return false;
  const node = ARCH_NODE_BY_ID.get(nodeId);
  if (node === undefined) return false;
  if (selection.joint !== null) return node.joints.includes(selection.joint);

  // No single joint, but a symbol: light every node whose citation falls inside
  // it. This is the "which parts of the architecture come from THIS code?"
  // direction, and it only applies when there is no joint — otherwise selecting
  // R4 would light all eight joint nodes, because all eight are cited inside
  // the one `ServoName` enum.
  const symbol = selection.symbolId === null ? undefined : SYMBOL_BY_ID.get(selection.symbolId);
  if (symbol === undefined || node.sourceRef === null) return false;
  return symbolContains(symbol, node.sourceRef.file, node.sourceRef.line);
}
