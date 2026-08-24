/**
 * The rig, checked against the real `assets/sesame.glb` — the same bytes the
 * browser downloads.
 *
 * These run in Node because `GLTFLoader.parse()` needs nothing but an
 * ArrayBuffer for a texture-free GLB, and because a check this cheap should not
 * require a browser to be present. The browser harness
 * (`scripts/capture-web-screenshots.mjs`) then repeats the geometric parts
 * *in* a browser, on the scene graph three.js actually built. Passing here and
 * failing there would mean the app, not the asset, is wrong — which is exactly
 * the distinction worth being able to make.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JOINT_ORDER, jointIndex, type JointName } from '@sesame-lab/sesame-model';
import { Object3D, Quaternion } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  applyCommandedDeg,
  buildRig,
  commandedDegFromNode,
  computeGroundPlaneMm,
  expectedQuaternion,
  groundReferenceMm,
  quaternionAngleDeg,
  readAssetFacts,
  type AssetFacts,
  type JointRig,
} from '../three/rig.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GLB = path.join(REPO, 'assets/sesame.glb');

let root: Object3D;
let rig: Record<JointName, JointRig>;
let facts: AssetFacts;

beforeAll(async () => {
  const bytes = fs.readFileSync(GLB);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', resolve, reject);
  });
  root = gltf.scene;
  rig = buildRig(root);
  facts = readAssetFacts(
    gltf.asset.extras,
    root.getObjectByName('oled_screen'),
    root.getObjectByName('body_top_cover'),
  );
});

describe('the GLB describes its own rig', () => {
  it('has all eight joints, on the right servo channels, in firmware order', () => {
    for (const joint of JOINT_ORDER) {
      expect(rig[joint].firmwareIndex).toBe(jointIndex(joint));
    }
    // R4 before R3 — the order is the wiring order, not a sort.
    expect(JOINT_ORDER.map((j) => rig[j].joint)).toEqual([
      'R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4',
    ]);
  });

  it('parents every knee under its own hip, so a foot follows its femur', () => {
    for (const [knee, hip] of [
      ['R3', 'R1'],
      ['R4', 'R2'],
      ['L3', 'L1'],
      ['L4', 'L2'],
    ] as const) {
      expect(rig[knee].node.parent?.name).toBe(hip);
      expect(rig[knee].parentNode).toBe(hip);
    }
  });

  it('ships every joint at the identity, so commandedDeg 90 is the rest pose', () => {
    for (const joint of JOINT_ORDER) {
      const q = rig[joint].node.quaternion;
      expect(quaternionAngleDeg(q, new Quaternion())).toBeLessThan(1e-9);
      expect(commandedDegFromNode(rig[joint])).toBeCloseTo(90, 9);
    }
  });

  it('declares every semantic name unverified', () => {
    for (const joint of JOINT_ORDER) {
      expect(rig[joint].semanticNameVerified).toBe(false);
      expect(rig[joint].semanticNameAlias).toBeTruthy();
    }
  });
});

describe('the pose rule', () => {
  it('round-trips every angle through the scene graph', () => {
    for (const joint of JOINT_ORDER) {
      for (const deg of [0, 1, 45, 89, 90, 91, 135, 179, 180]) {
        applyCommandedDeg(rig[joint], deg);
        expect(commandedDegFromNode(rig[joint]), `${joint} at ${deg}`).toBeCloseTo(deg, 9);
      }
      applyCommandedDeg(rig[joint], 90);
    }
  });

  it('turns hips and knees in opposite senses, as the asset says', () => {
    // Read, not asserted from memory: hips -1, knees +1, out of
    // assembly-map.json's rotationSense.rule.
    for (const joint of ['R1', 'R2', 'L1', 'L2'] as const) expect(rig[joint].sign).toBe(-1);
    for (const joint of ['R3', 'R4', 'L3', 'L4'] as const) expect(rig[joint].sign).toBe(1);
  });
});

describe('the reference pose reproduces V2’s own numbers', () => {
  it('is runStandPose, with the eight angles V1 also produces', () => {
    expect(facts.referencePose.identifiedAs).toBe('runStandPose');
    expect(facts.referencePose.commandedDeg).toEqual({
      R1: 135, R2: 45, L1: 45, L2: 135, R3: 180, R4: 0, L3: 0, L4: 180,
    });
  });

  it('puts the feet on V2’s recorded ground plane, to sub-nanometre', () => {
    for (const joint of JOINT_ORDER) {
      applyCommandedDeg(rig[joint], facts.referencePose.commandedDeg[joint] ?? 90);
    }
    root.updateMatrixWorld(true);

    const mm = computeGroundPlaneMm(rig);
    expect(mm).not.toBeNull();
    // V2: −68.650046 mm, "min over the canonical Y of every foot vertex at the
    // pose in question". Recomputed here from the float32 vertex data in the
    // shipped file, through the parenting, the axes and the signs — so a wrong
    // sign anywhere moves this number.
    expect(mm ?? 0).toBeCloseTo(facts.groundPlane.atRunStandPoseMm, 4);
  });

  it('is a different ground plane at rest, and the asset says so', () => {
    for (const joint of JOINT_ORDER) applyCommandedDeg(rig[joint], 90);
    root.updateMatrixWorld(true);

    const mm = computeGroundPlaneMm(rig);
    expect(mm ?? 0).toBeCloseTo(facts.groundPlane.atRestPoseMm, 4);
    // The two must not be collapsible into a constant: at rest the feet are
    // horizontal, so the robot is higher.
    expect(facts.groundPlane.atRestPoseMm).toBeGreaterThan(facts.groundPlane.atRunStandPoseMm);
  });

  it('matches the quaternion the rule predicts, joint by joint', () => {
    for (const joint of JOINT_ORDER) {
      const deg = facts.referencePose.commandedDeg[joint] ?? 90;
      applyCommandedDeg(rig[joint], deg);
      const error = quaternionAngleDeg(rig[joint].node.quaternion, expectedQuaternion(rig[joint], deg));
      expect(error).toBeLessThan(1e-9);
    }
  });
});

describe('the asset carries its own provenance', () => {
  it('is in metres, in the canonical frame, with no axis conversion', () => {
    expect(facts.millimetresPerUnit).toBe(1000);
    expect(facts.canonicalFrame.id).toBe('sesame-robot');
    expect(facts.canonicalFrame.upAxis).toBe('+Y');
    expect(facts.canonicalFrame.forwardAxis).toBe('-Z');
  });

  it('declares the top-cover substitution rather than hiding it', () => {
    expect(facts.topCoverSubstitution).not.toBeNull();
    expect(facts.topCoverSubstitution?.substitutedFor).toBe('Top-Cover-Enclosed-v117.stl');
    expect(facts.topCoverSubstitution?.reason).toMatch(/watertight/i);
  });

  it('says nothing has been physically verified', () => {
    expect(String(facts.verificationStatus)).toMatch(/NOT PHYSICALLY VERIFIED/);
  });

  it('marks the OLED active plane inferred, not measured', () => {
    expect(facts.oled.framebufferPx).toEqual([128, 64]);
    expect(facts.oled.planeSizeMm).toEqual([23.6, 11.8]);
    expect(facts.oled.planeStatus).toBe('inferred');
    expect(facts.oled.planeMethod).toMatch(/DECISION of V2/);
    // The 20-degree backward tilt and the outward normal V4 relies on.
    expect(facts.oled.tiltFromVerticalDeg).toBe(20);
    expect(facts.oled.outwardNormal?.[2]).toBeLessThan(0);
  });

  it('refuses to let the ground plane be treated as a constant', () => {
    expect(facts.groundPlane.method).toMatch(/POSE-DEPENDENT/);
    expect(facts.doNotAssume.some((s) => /ground plane/i.test(s))).toBe(true);
  });
});

describe('the oled_screen quad is what V4 needs', () => {
  it('exists, is a single quad, and has UVs', () => {
    const node = root.getObjectByName('oled_screen');
    expect(node).toBeDefined();
    const mesh = node as unknown as { geometry: { index: { count: number } | null; attributes: Record<string, unknown> } };
    expect(mesh.geometry.attributes['uv']).toBeDefined();
    expect(mesh.geometry.index?.count).toBe(6); // two triangles
  });
});

/**
 * The measurements behind the viewer's fixed floor — ISSUE-20260823-023.
 *
 * The bug was that `GroundPlane` drove the grid from `computeGroundPlaneMm`
 * every frame, so the only static object on screen slid vertically under a
 * robot root that never moves. The fix pins the floor at the reference pose's
 * plane. These tests are the load-bearing half of that argument: they check the
 * two geometric facts that make one fixed plane the *right* answer, so a future
 * calibration that flips a hip axis or moves a pivot fails here rather than
 * silently reintroducing feet that hover or sink.
 *
 * The stability of the rendered scene itself is asserted in a real browser, off
 * `matrixWorld`, by scripts/capture-web-screenshots.mjs phase 1 — nothing in
 * Node can see a React scene graph.
 */
describe('the viewer\u2019s floor is a constant, and the right one', () => {
  const KNEES = ['R3', 'R4', 'L3', 'L4'] as const;
  const HIPS = ['R1', 'R2', 'L1', 'L2'] as const;

  const rest = (): void => {
    for (const joint of JOINT_ORDER) applyCommandedDeg(rig[joint], 90);
    root.updateMatrixWorld(true);
  };

  it('reads its height out of the asset rather than carrying a number', () => {
    expect(groundReferenceMm(facts)).toBe(facts.groundPlane.atRunStandPoseMm);
    expect(groundReferenceMm(facts)).toBeCloseTo(-68.650046, 6);
  });

  it('does not move while the pose-dependent ground plane moves 37 mm', () => {
    const floor = groundReferenceMm(facts);
    const contacts: number[] = [];
    for (const pose of [
      facts.referencePose.commandedDeg,
      Object.fromEntries(JOINT_ORDER.map((j) => [j, 90])),
      // Knees folded the other way: all four feet come off the reference plane
      // at once, which is the shape of runShrugPose and runDeadPose.
      { R1: 135, R2: 45, L1: 45, L2: 135, R3: 90, R4: 180, L3: 180, L4: 90 },
    ] as Record<string, number>[]) {
      for (const joint of JOINT_ORDER) applyCommandedDeg(rig[joint], pose[joint] ?? 90);
      root.updateMatrixWorld(true);
      contacts.push(computeGroundPlaneMm(rig) ?? Number.NaN);
      // The whole point: the floor is not a function of the pose.
      expect(groundReferenceMm(facts)).toBe(floor);
    }
    expect(Math.max(...contacts) - Math.min(...contacts)).toBeGreaterThan(30);
    rest();
  });

  it('cannot be reached through by any knee angle, to better than 0.3 mm', () => {
    // Foot height is a function of the knees alone (see the hip test below), and
    // each leg is independent, so sweeping one knee at a time covers the space.
    rest();
    let deepest = Number.POSITIVE_INFINITY;
    for (const knee of KNEES) {
      for (let deg = 0; deg <= 180; deg += 1) {
        applyCommandedDeg(rig[knee], deg);
        root.updateMatrixWorld(true);
        deepest = Math.min(deepest, computeGroundPlaneMm(rig) ?? Number.POSITIVE_INFINITY);
      }
      applyCommandedDeg(rig[knee], 90);
    }
    rest();
    // −68.9233 mm (R4/L4) against a floor at −68.6500 mm: 0.27 mm of possible
    // interpenetration on a 130 mm robot, and only at a hand-dialled angle no
    // movement in the choreography uses.
    expect(deepest).toBeGreaterThan(groundReferenceMm(facts) - 0.3);
    expect(deepest).toBeLessThan(groundReferenceMm(facts));
  });

  it('is unaffected by the hips, because the hips are yaw joints', () => {
    // If this ever fails, the hips have stopped being yaw and foot height is no
    // longer a function of the knees alone — at which point the sweep above no
    // longer covers the pose space and the fixed-floor argument needs redoing.
    rest();
    const flat = computeGroundPlaneMm(rig) ?? Number.NaN;
    for (const hip of HIPS) {
      for (let deg = 0; deg <= 180; deg += 15) {
        applyCommandedDeg(rig[hip], deg);
        root.updateMatrixWorld(true);
        expect(computeGroundPlaneMm(rig) ?? Number.NaN).toBeCloseTo(flat, 9);
      }
      applyCommandedDeg(rig[hip], 90);
    }
    rest();
  });
});
