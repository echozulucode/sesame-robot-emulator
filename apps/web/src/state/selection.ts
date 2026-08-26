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
 * ```
 *
 * The only way that stays true as panes are added is if there is exactly one
 * selection object and every pane both writes it and reads it. So this module
 * owns the concept, and nothing else is allowed to keep a private "selected"
 * of its own.
 *
 * ## The shape, and why it has two fields rather than one
 *
 * A selection has a **joint** and a **graph node**, and they are not the same
 * thing. Clicking `R4` in the 3D scene selects a joint, and the graph node
 * `joint.R4` follows. Clicking `LEDC / PWM` in the graph selects a node that is
 * about all eight joints and therefore highlights no single one — collapsing
 * that to "the joint is null" would be right, but collapsing it to "pick the
 * first joint" would be a lie the 3D scene would then render.
 *
 * `origin` records which pane initiated it. Panes use it for one thing only:
 * not to fight each other for scroll position.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';

import { ARCH_NODE_BY_ID, JOINT_FACTS } from '../generated/architecture-graph.js';
import { expansionsFor } from '../arch/layout.js';

export type SelectionOrigin = 'scene' | 'graph' | 'trace' | 'inspector';

export interface SelectionState {
  /** Which pane set it. `null` only for the empty selection. */
  readonly origin: SelectionOrigin | null;
  /** The joint this selection is about, or `null` when it is about no one joint. */
  readonly joint: JointName | null;
  /** The architecture node this selection is about, or `null`. */
  readonly nodeId: string | null;
}

export const EMPTY_SELECTION: SelectionState = Object.freeze({
  origin: null,
  joint: null,
  nodeId: null,
});

const isJointName = (value: string): value is JointName =>
  (JOINT_ORDER as readonly string[]).includes(value);

/**
 * Select a joint. The graph node `joint.<name>` comes along for free — it is
 * generated from `servos.joints[]`, so it always exists for a real joint.
 */
export function selectJoint(joint: JointName | null, origin: SelectionOrigin): SelectionState {
  if (joint === null) return EMPTY_SELECTION;
  return { origin, joint, nodeId: JOINT_FACTS[joint]?.nodeId ?? `joint.${joint}` };
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
  };
}

/** Nothing selected. */
export function isEmptySelection(selection: SelectionState): boolean {
  return selection.joint === null && selection.nodeId === null;
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
  if (selection.joint === null || selection.nodeId === nodeId) return false;
  const node = ARCH_NODE_BY_ID.get(nodeId);
  if (node === undefined) return false;
  return node.joints.includes(selection.joint);
}
