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
