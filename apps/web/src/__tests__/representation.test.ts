/**
 * The three representations — Phase 4 W4.
 *
 * These are unit tests of the DECISION and the SCOPE, not of the pixels: which
 * artifact a width picks, which nodes a subsystem shows, and what the causal
 * path actually walks. What a browser must prove instead — that the artifact
 * the decision names is the one mounted, that its text clears 14 px on screen,
 * and that the cross-highlight survives all three — is asserted in
 * `scripts/capture-web-screenshots.mjs` phase 7, because none of it can be
 * proved without layout.
 */
import { describe, expect, it } from 'vitest';

import {
  archModeForWidth,
  ARCH_BANDS,
  ARCH_SUBSYSTEM_MAX_NODES,
  causalPath,
  DEFAULT_FOCUS_NODE_ID,
  focusNodeFor,
  PATH_BRANCHES_SHOWN,
  subsystemForNode,
  subsystemScope,
  SUBSYSTEMS,
} from '../arch/representation.js';
import { ARCH_NODES, ARCH_NODE_BY_ID } from '../generated/architecture-graph.js';
import { layoutArchitecture, SUBSYSTEM_METRICS } from '../arch/layout.js';
import { PANE_BANDS } from '../ui/use-container-width.js';

const NONE: ReadonlySet<string> = new Set<string>();

describe('archModeForWidth — the brief’s thresholds, and only those', () => {
  it('is the brief’s function verbatim', () => {
    expect(archModeForWidth(0)).toBe('path');
    expect(archModeForWidth(719)).toBe('path');
    expect(archModeForWidth(720)).toBe('subsystem');
    expect(archModeForWidth(959)).toBe('subsystem');
    expect(archModeForWidth(960)).toBe('full');
    expect(archModeForWidth(4000)).toBe('full');
  });

  it('treats an unmeasured box as the narrowest, not the widest', () => {
    // `useContainerWidth()` reports `null` before its first observation and
    // calls that `wide` for the generic pane band, because showing a table
    // early is harmless. Mounting 63 React Flow nodes for one frame is not.
    expect(archModeForWidth(Number.NaN)).toBe('path');
  });

  it('is a SECOND table, deliberately not PANE_BANDS', () => {
    // W2's generic table is 520/720 and the stylesheet mirrors it; the harness
    // fails statically on a third threshold there. These are 720/960 and they
    // come from the artifact — 63 nodes and 65 edges — not from a column count.
    expect(ARCH_BANDS.subsystem).toBe(720);
    expect(ARCH_BANDS.full).toBe(960);
    expect(PANE_BANDS.medium).toBe(520);
    expect(PANE_BANDS.wide).toBe(720);
    // The one number they share is 720, and it means different things on each
    // side: "this pane can hold two columns" and "this pane can hold one
    // subsystem". They are allowed to coincide; they are not the same rule.
    expect(ARCH_BANDS.subsystem).toBe(PANE_BANDS.wide);
  });
});

describe('the focus — what the scoped views are ABOUT', () => {
  it('prefers the selection', () => {
    expect(focusNodeFor('joint.R4', new Set(['servo.ledc']))).toBe('joint.R4');
  });

  it('falls back to the deepest node the trace lit', () => {
    // A wave lights the whole chain; the deepest thing it reached is a joint,
    // which is where a tracing task wants to start reading backwards from.
    const active = new Set(['movement', 'servos', 'servo.ledc', 'joint.L3']);
    expect(focusNodeFor(null, active)).toBe('joint.L3');
  });

  it('falls back to the chain the product teaches', () => {
    expect(focusNodeFor(null, NONE)).toBe(DEFAULT_FOCUS_NODE_ID);
    expect(ARCH_NODE_BY_ID.has(DEFAULT_FOCUS_NODE_ID)).toBe(true);
  });

  it('ignores a selected id that is not a node', () => {
    // `hardware/lessons.json` has one: the `graph-node-picker` target `i2c`,
    // where the node is `oled.i2c`. See the W4 findings.
    expect(ARCH_NODE_BY_ID.has('i2c')).toBe(false);
    expect(focusNodeFor('i2c', NONE)).toBe(DEFAULT_FOCUS_NODE_ID);
  });
});

describe('the causal path', () => {
  it('walks the brief’s worked example for a joint', () => {
    const path = causalPath('joint.R4', NONE);
    expect(path.nodeIds).toEqual([
      'esp32',
      'movement',
      'servos',
      'servo.setServoAngle',
      'servo.esp32servo',
      'servo.ledc',
      'servo.gpio',
      'servo.mg90s',
      'joint.R4',
    ]);
  });

  it('carries the edge labels the generator derived, not new prose', () => {
    const path = causalPath('joint.R4', NONE);
    const via = new Map(path.steps.map((s) => [s.node.id, s.via]));
    expect(via.get('servos')?.label).toBe('111 setServoAngle steps');
    expect(via.get('servo.esp32servo')?.label).toBe('servos[channel]');
    expect(via.get('servo.gpio')?.label).toBe('50 Hz frame');
  });

  it('marks the hand-authored edge that reaches a joint', () => {
    // `servo.mg90s -> joint.*` is one of the five claims no artefact in this
    // repository makes. The path view walks it every time it ends on a joint,
    // so it has to say so — dashing an edge is not available when there are no
    // edges to dash.
    const step = causalPath('joint.L3', NONE).steps.at(-1);
    expect(step?.node.id).toBe('joint.L3');
    expect(step?.via?.derivation).toBe('hand-authored');
  });

  it('reaches every one of the 63 nodes', () => {
    for (const node of ARCH_NODES) {
      const path = causalPath(node.id, NONE);
      expect(path.nodeIds.at(-1)).toBe(node.id);
      expect(path.nodeIds[0]).toBe('esp32');
    }
  });

  it('degrades to the root for an id the graph does not have', () => {
    expect(causalPath('i2c', NONE).nodeIds).toEqual(['esp32']);
  });

  it('puts the branches the trace lit first, and counts the rest', () => {
    // After a wave, `runWavePose` is the branch off Movement a reader is
    // looking for, and it is neither first nor last in generator order.
    const path = causalPath('joint.R4', new Set(['movement.runWavePose']));
    const movement = path.steps.find((s) => s.node.id === 'movement');
    expect(movement?.branches[0]?.id).toBe('movement.runWavePose');
    expect(movement?.branches.length).toBe(PATH_BRANCHES_SHOWN);
    // 21 movement functions, one of which is now on the chip row.
    expect(movement?.allBranches.length).toBe(21);
    expect(movement?.branchesOmitted).toBe(21 - PATH_BRANCHES_SHOWN);
  });

  it('never lists a node that is already on the path as a branch', () => {
    const path = causalPath('joint.R4', NONE);
    const onPath = new Set(path.nodeIds);
    for (const step of path.steps) {
      for (const branch of step.allBranches) expect(onPath.has(branch.id)).toBe(false);
    }
  });
});

describe('the subsystem scope — a product rule, enforced', () => {
  it('offers exactly the four setup() branches', () => {
    expect(SUBSYSTEMS.map((s) => s.id)).toEqual(['movement', 'face', 'network', 'serial']);
  });

  it('shows the servo chain and all eight joints, and no partial sets', () => {
    const scope = subsystemScope('movement', 'joint.R4');
    expect([...scope.ids].sort()).toEqual(
      [
        'esp32',
        'movement',
        'servos',
        'servo.setServoAngle',
        'servo.esp32servo',
        'servo.ledc',
        'servo.gpio',
        'servo.mg90s',
        'joint.R1',
        'joint.R2',
        'joint.L1',
        'joint.L2',
        'joint.R4',
        'joint.R3',
        'joint.L3',
        'joint.L4',
      ].sort(),
    );
    // The 21 movement functions do not fit beside them, so they are counted
    // rather than sampled: "R1, R2 and six more joints" would say six joints
    // were less real than two.
    expect(scope.omitted).toBe(21);
    expect(scope.total).toBe(36);
  });

  it('never exceeds the budget, for any subsystem or focus', () => {
    for (const subsystem of SUBSYSTEMS) {
      for (const node of ARCH_NODES) {
        const scope = subsystemScope(subsystem.id, node.id);
        // The root anchors every scope and is not one of the subsystem's own.
        expect(scope.ids.size - 1).toBeLessThanOrEqual(ARCH_SUBSYSTEM_MAX_NODES);
        expect(scope.ids.size - 1).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('shows the OLED chain whole — 10 nodes, nothing omitted', () => {
    const scope = subsystemScope('face', 'oled.i2c');
    expect(scope.omitted).toBe(0);
    expect(scope.ids.has('oled.pixels')).toBe(true);
    expect(scope.ids.has('oled.controller')).toBe(true);
  });

  it('shows all ten HTTP routes whole', () => {
    const scope = subsystemScope('network', 'http-api');
    expect(scope.omitted).toBe(0);
    for (let i = 0; i < 10; i++) expect(scope.ids.has(`route.${String(i)}`)).toBe(true);
  });

  it('is independent of the expand/collapse state', () => {
    // Expansion is the full graph's affordance. A subsystem view that obeyed it
    // would draw two boxes when the subsystem happened to be collapsed and call
    // that a neighbourhood.
    const scope = subsystemScope('movement', 'joint.R4');
    const collapsed = layoutArchitecture(new Set<string>(), {
      scope: scope.ids,
      metrics: SUBSYSTEM_METRICS,
    });
    const expanded = layoutArchitecture(new Set(['servos', 'movement']), {
      scope: scope.ids,
      metrics: SUBSYSTEM_METRICS,
    });
    expect(collapsed.nodes.map((n) => n.node.id)).toEqual(expanded.nodes.map((n) => n.node.id));
    expect(collapsed.nodes.length).toBe(16);
  });

  it('lifts edges onto the scope, so the chain is drawn and nothing dangles', () => {
    const scope = subsystemScope('movement', 'joint.R4');
    const layout = layoutArchitecture(new Set<string>(), {
      scope: scope.ids,
      metrics: SUBSYSTEM_METRICS,
    });
    const pairs = layout.edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('servo.ledc->servo.gpio');
    expect(pairs).toContain('servo.mg90s->joint.R4');
    for (const edge of layout.edges) {
      expect(scope.ids.has(edge.source)).toBe(true);
      expect(scope.ids.has(edge.target)).toBe(true);
    }
  });

  it('maps a node to its subsystem, and the root to none', () => {
    expect(subsystemForNode('joint.R4')).toBe('movement');
    expect(subsystemForNode('oled.i2c')).toBe('face');
    expect(subsystemForNode('route.5')).toBe('network');
    expect(subsystemForNode('esp32')).toBe(null);
    expect(subsystemForNode('i2c')).toBe(null);
    expect(subsystemForNode(null)).toBe(null);
  });
});

describe('L6 clicks graph nodes, and the scoped views must still reach them', () => {
  /**
   * The three `graph-node-picker` steps in `hardware/lessons.json`, verbatim.
   *
   * L6's control is a button in the LEARN pane that calls `selectNode(target)`,
   * not a click inside the graph, so no representation can stop a lesson step
   * from firing. What a representation CAN do is fail to show the node the step
   * just selected, which would leave a learner reading "click the OLED node"
   * beside a pane that does not contain one.
   */
  const L6_TARGETS = [
    { lesson: 'meet-sesame', status: 'polished', target: 'oled' },
    { lesson: 'two-wires-to-a-face', status: 'outline', target: 'i2c' },
    { lesson: 'sesame-on-a-network', status: 'outline', target: 'network' },
  ] as const;

  it('puts every resolvable target on the causal path, at its end', () => {
    for (const { target } of L6_TARGETS) {
      if (!ARCH_NODE_BY_ID.has(target)) continue;
      const path = causalPath(target, NONE);
      expect(path.nodeIds.at(-1)).toBe(target);
      expect(path.steps.length).toBeGreaterThan(1);
    }
  });

  it('puts every resolvable target in its own subsystem view', () => {
    for (const { target } of L6_TARGETS) {
      const subsystem = subsystemForNode(target);
      if (subsystem === null) continue;
      expect(subsystemScope(subsystem, target).ids.has(target)).toBe(true);
    }
  });

  it('records the one target that is not a node id, and why it is not a break', () => {
    // `two-wires-to-a-face` asks for `i2c`; the generated node is `oled.i2c`.
    // This predates W4 - `selectNode('i2c')` has always set a nodeId no pane
    // can render - and the lesson is `outline` rather than `polished`, so L6
    // never built it and phase 10 never plays it. It is recorded here rather
    // than smoothed over in `selectNode()`, because a lesson naming a node that
    // does not exist is a fact about `hardware/lessons.json` and this task does
    // not own `hardware/`. If somebody fixes the data, this test fails and says
    // so, which is the point.
    const unresolved = L6_TARGETS.filter((t) => !ARCH_NODE_BY_ID.has(t.target));
    expect(unresolved.map((t) => `${t.lesson}:${t.target}`)).toEqual([
      'two-wires-to-a-face:i2c',
    ]);
    expect(unresolved.every((t) => t.status === 'outline')).toBe(true);
    expect(ARCH_NODE_BY_ID.has('oled.i2c')).toBe(true);
  });
});

describe('the subsystem box is smaller in FOOTPRINT, never in type', () => {
  it('spends the summary’s extra lines, not a font size', () => {
    // The 14 px floor is not negotiable, so what the compact box gives up is
    // the two summary lines that repeat the detail panel below it.
    expect(SUBSYSTEM_METRICS.nodeW).toBe(192);
    expect(SUBSYSTEM_METRICS.nodeH).toBeLessThan(112);
    expect(SUBSYSTEM_METRICS.rowH).toBeLessThan(136);
  });
});
