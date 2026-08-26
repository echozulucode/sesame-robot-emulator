/**
 * The architecture graph, held against `hardware/hardware-map.json` itself.
 *
 * The generator projects the graph; these tests re-read the source JSON and
 * check the projection independently, so a generator bug that produced a
 * plausible-looking graph would still fail here. That is the same posture as
 * `catalog-drift.test.ts`: the artefact is not trusted just because a script
 * wrote it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCH_EDGES,
  ARCH_NODES,
  ARCH_NODE_BY_ID,
  COMMAND_TRACE_BY_NAME,
  HAND_AUTHORED,
  PWM_FACTS,
  ROOT_NODE_IDS,
  UPSTREAM_COMMIT,
} from '../generated/architecture-graph.js';
import { ancestorsOf, childrenOf, layoutArchitecture } from '../arch/layout.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const map = JSON.parse(
  fs.readFileSync(path.join(REPO, 'hardware/hardware-map.json'), 'utf8'),
) as Record<string, any>;

describe('the graph is projected from the data, not drawn', () => {
  it('pins every sourceRef to the same upstream commit the map does', () => {
    expect(UPSTREAM_COMMIT).toBe(map['meta'].sourceTree.upstreamCommit);
    expect(UPSTREAM_COMMIT).toHaveLength(40);
  });

  it('has one node per joint, in firmware enum order, with the enum index', () => {
    const order: string[] = map['servos'].order;
    const jointNodes = ARCH_NODES.filter((n) => n.kind === 'joint');
    expect(jointNodes.map((n) => n.label)).toEqual(order);
    for (const [i, name] of order.entries()) {
      const node = ARCH_NODE_BY_ID.get(`joint.${name}`);
      expect(node?.joints).toEqual([name]);
      expect(node?.summary).toContain(`channel ${i}`);
    }
    // R4 before R3. If this ever sorts alphabetically, four servos are rewired
    // in the reader's head.
    expect(order.indexOf('R4')).toBeLessThan(order.indexOf('R3'));
  });

  it('has one node per HTTP route, all ten of them', () => {
    const routes = map['network'].http.routes as { path: string; handlerSymbol: string }[];
    const routeNodes = ARCH_NODES.filter((n) => n.kind === 'route');
    expect(routeNodes).toHaveLength(routes.length);
    expect(routeNodes.map((n) => n.summary)).toEqual(routes.map((r) => r.handlerSymbol));
  });

  it('has one node per movement function, all twenty-one', () => {
    const fns = (map['movements'] as { function: string }[]).map((m) => m.function);
    const nodes = ARCH_NODES.filter((n) => n.kind === 'movement');
    expect(nodes.map((n) => n.label)).toEqual(fns);
  });

  it('never invents an edge endpoint', () => {
    for (const e of ARCH_EDGES) {
      expect(ARCH_NODE_BY_ID.has(e.source)).toBe(true);
      expect(ARCH_NODE_BY_ID.has(e.target)).toBe(true);
    }
  });

  it('marks the MG90S as unresolved, quoting the map’s own reason', () => {
    const mg90s = ARCH_NODE_BY_ID.get('servo.mg90s');
    expect(mg90s?.unresolved).toBe('servo-model');
    const entry = (map['unresolved'] as { id: string; reason: string }[]).find(
      (u) => u.id === 'servo-model',
    );
    expect(mg90s?.detail[0]).toBe(entry?.reason);
  });

  it('keeps the hand-authored list short, explicit and enumerated', () => {
    // The four top-level groupings, plus the GPIO->horn wire nobody traced.
    expect([...HAND_AUTHORED].sort()).toEqual([
      'edge servo.mg90s->joint.R1',
      'node face',
      'node movement',
      'node network',
      'node serial',
    ]);
    const derived = ARCH_NODES.filter((n) => n.derivation === 'derived');
    expect(derived.length).toBe(ARCH_NODES.length - 4);
  });

  it('refuses to claim a per-joint LEDC channel', () => {
    // Q3 measured WHICH eight channels are programmed and nothing says which
    // servo owns which. The report's `channel=6` is illustrative; drawing it
    // would be inventing a fact in the pane a learner trusts most.
    expect(PWM_FACTS.channelPerJointKnown).toBe(false);
    expect(PWM_FACTS.channelsProgrammed).toHaveLength(8);
    for (const node of ARCH_NODES) {
      for (const line of [node.label, node.summary]) {
        expect(line).not.toMatch(/channel\s*=\s*\d/);
      }
    }
  });
});

describe('collapse and expand', () => {
  it('starts at exactly the report’s top level', () => {
    const layout = layoutArchitecture(new Set());
    expect(layout.nodes.map((n) => n.node.id).sort()).toEqual([...ROOT_NODE_IDS].sort());
  });

  it('lifts hidden edges to the visible frontier so the tree still reads', () => {
    const collapsed = layoutArchitecture(new Set());
    const pairs = collapsed.edges.map((e) => `${e.source}->${e.target}`);
    // ESP32 -> four branches -> four targets, exactly the report's ASCII.
    expect(pairs).toContain('esp32->movement');
    expect(pairs).toContain('esp32->face');
    expect(pairs).toContain('esp32->network');
    expect(pairs).toContain('esp32->serial');
    expect(pairs).toContain('movement->servos');
    expect(pairs).toContain('face->oled');
    expect(pairs).toContain('network->http-api');
    expect(pairs).toContain('serial->developer');
    // Nothing below the frontier leaked out.
    expect(pairs.some((p) => p.includes('servo.ledc'))).toBe(false);
  });

  it('reveals the true servo chain when Servos is expanded', () => {
    const layout = layoutArchitecture(new Set(['servos']));
    const ids = layout.nodes.map((n) => n.node.id);
    for (const id of [
      'servo.setServoAngle',
      'servo.esp32servo',
      'servo.ledc',
      'servo.gpio',
      'servo.mg90s',
      'joint.L3',
    ]) {
      expect(ids).toContain(id);
    }
    const pairs = layout.edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('servo.setServoAngle->servo.esp32servo');
    expect(pairs).toContain('servo.esp32servo->servo.ledc');
    expect(pairs).toContain('servo.ledc->servo.gpio');
    expect(pairs).toContain('servo.gpio->servo.mg90s');
    expect(pairs).toContain('servo.mg90s->joint.L3');
  });

  it('reveals the true OLED chain when OLED is expanded', () => {
    const ids = layoutArchitecture(new Set(['oled'])).nodes.map((n) => n.node.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'oled.faceName',
        'oled.bitmap',
        'oled.gfx',
        'oled.ssd1306',
        'oled.wire',
        'oled.i2c',
        'oled.controller',
        'oled.pixels',
      ]),
    );
  });

  it('never overlaps two nodes', () => {
    const layout = layoutArchitecture(new Set(['servos', 'oled', 'http-api', 'developer', 'movement']));
    const seen = new Set<string>();
    for (const n of layout.nodes) {
      const key = `${n.x},${n.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('knows what to expand to reach a buried node', () => {
    expect(ancestorsOf('joint.R4')).toEqual(['servos']);
    expect(childrenOf('servos').length).toBe(13);
  });
});

describe('the trace facts come from the same JSON', () => {
  it('maps wave to runWavePose with its real banner and joints', () => {
    const wave = COMMAND_TRACE_BY_NAME.get('wave');
    expect(wave?.movementFunction).toBe('runWavePose');
    expect(wave?.logBanner).toBe('WAVE');
    // Enum order, and the report's own example joint.
    expect(wave?.joints).toEqual(['R1', 'L2', 'R4', 'L3']);
  });

  it('covers every command word in the firmware vocabulary', () => {
    const vocab = (map['commands'].vocabulary as { command: string }[])
      .map((v) => v.command)
      .filter((c) => c.length > 0);
    for (const command of vocab) expect(COMMAND_TRACE_BY_NAME.has(command)).toBe(true);
  });
});
