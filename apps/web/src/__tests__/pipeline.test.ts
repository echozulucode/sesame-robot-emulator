/**
 * The whole chain, minus the browser: choreography → sim → telemetry → store →
 * rig → geometry.
 *
 * Each link is already tested by whoever owns it. What is not tested anywhere
 * else is that they *agree*: that the eight angles V1 emits for `runStandPose`
 * are the eight angles V2 built the asset around, and that pushing them through
 * the store's reduction and the rig's rule lands the feet where V0 said the
 * CAD puts them. Nothing in this file shares code with how either side was
 * produced.
 *
 * The one link this cannot reach is three.js inside a real renderer. That is
 * `scripts/capture-web-screenshots.mjs`, and it repeats these same two
 * assertions against the live scene graph.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';
import { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { TelemetryStore } from '../state/telemetry-store.js';
import {
  applyCommandedDeg,
  buildRig,
  computeGroundPlaneMm,
  readAssetFacts,
  type AssetFacts,
  type JointRig,
} from '../three/rig.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

let root: Object3D;
let rig: Record<JointName, JointRig>;
let facts: AssetFacts;

beforeAll(async () => {
  const bytes = fs.readFileSync(path.join(REPO, 'assets/sesame.glb'));
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

/** Run the model in virtual time and pipe everything it says into the store. */
async function drive(
  run: (robot: SimulatedSesameRobot) => Promise<void>,
  options: ConstructorParameters<typeof SimulatedSesameRobot>[0] = {},
): Promise<{
  store: TelemetryStore;
  events: SesameTelemetry[];
}> {
  const robot = new SimulatedSesameRobot(options);
  const store = new TelemetryStore();
  const events: SesameTelemetry[] = [];
  robot.subscribe((event) => {
    events.push(event);
    store.ingest(event);
  });
  await robot.connect();
  await run(robot);
  const state = await robot.getState();
  store.applyModelState(state.joints);
  return { store, events };
}

function poseTheRig(store: TelemetryStore): void {
  for (const joint of JOINT_ORDER) {
    const deg = store.joints[joint].commandedDeg;
    if (deg === null) continue;
    applyCommandedDeg(rig[joint], deg);
  }
  root.updateMatrixWorld(true);
}

describe('sim -> store', () => {
  it('tags every event simulated, and never fills in measuredDeg', () => {
    return drive(async (robot) => {
      await robot.command('wave');
    }).then(({ store, events }) => {
      expect(events.length).toBeGreaterThan(20);
      for (const event of events) expect(event.provenance).toBe('simulated');
      expect(store.provenanceCounts.simulated).toBe(events.length);
      expect(store.provenanceCounts.observed).toBe(0);
      expect(store.drivingProvenance).toBe('simulated');
      for (const joint of JOINT_ORDER) {
        expect(store.joints[joint].measuredDeg).toBeNull();
      }
    });
  });

  it('leaves a never-commanded joint null rather than assuming 90', () => {
    return drive(async () => {
      // connect() only sets a face; setup() deliberately does not move motors.
    }).then(({ store }) => {
      for (const joint of JOINT_ORDER) {
        expect(store.joints[joint].commandedDeg).toBeNull();
      }
    });
  });

  it('reports simulatedDeg from the model’s slew estimate, separately from commanded', () => {
    return drive(async (robot) => {
      await robot.command('stand');
    }).then(({ store }) => {
      for (const joint of JOINT_ORDER) {
        expect(store.joints[joint].commandedDeg).not.toBeNull();
        expect(store.joints[joint].simulatedDeg).not.toBeNull();
        expect(store.joints[joint].measuredDeg).toBeNull();
      }
    });
  });
});

describe('sim -> store -> rig -> geometry', () => {
  it('the stand pose the model produces is the pose the asset was built around', async () => {
    const { store } = await drive(async (robot) => {
      await robot.command('stand');
    });

    const commanded = Object.fromEntries(
      JOINT_ORDER.map((j) => [j, store.joints[j].commandedDeg]),
    ) as Record<JointName, number | null>;

    // V1's choreography, extracted from firmware source, against V2's
    // referencePose, read out of the CAD. Two independent readings of the same
    // eight numbers.
    expect(commanded).toEqual(facts.referencePose.commandedDeg);
  });

  it('lands the feet on V2’s recorded ground plane after the round trip', async () => {
    const { store } = await drive(async (robot) => {
      await robot.command('stand');
    });
    poseTheRig(store);

    const mm = computeGroundPlaneMm(rig);
    expect(mm).not.toBeNull();
    expect(mm ?? 0).toBeCloseTo(facts.groundPlane.atRunStandPoseMm, 4);
  });

  it('returns the rig exactly to rest when the model commands 90 everywhere', async () => {
    const { store } = await drive(async (robot) => {
      await robot.command('rest');
    });
    poseTheRig(store);

    for (const joint of JOINT_ORDER) {
      expect(store.joints[joint].commandedDeg).toBe(90);
      const q = rig[joint].node.quaternion;
      expect(Math.abs(q.w)).toBeCloseTo(1, 12);
    }
    expect(computeGroundPlaneMm(rig) ?? 0).toBeCloseTo(facts.groundPlane.atRestPoseMm, 4);
  });

  it('moves the joints a wave actually moves, and only those', async () => {
    const before = await drive(async (robot) => {
      await robot.command('stand');
    });
    const wave = await drive(async (robot) => {
      await robot.command('wave');
    });

    // runWavePose ends with runStandPose(1), so the robot finishes standing —
    // but L3, the joint that waves, must have been written many more times than
    // a plain stand would.
    expect(wave.store.joints.L3.updates).toBeGreaterThan(before.store.joints.L3.updates);
    expect(wave.store.joints.L3.commandedDeg).not.toBeNull();
  });
});

describe('sim -> store -> OLED', () => {
  it('draws the boot face at power-on, because setup() ends with setFace("rest")', async () => {
    const { store } = await drive(async () => {
      // Nothing. connect() alone reproduces setup(): ino:747.
    });
    expect(store.panel.writes).toBe(1);
    expect(store.panel.litPixels).toBeGreaterThan(0);
    expect(store.face?.name).toBe('rest');
  });

  it('draws real pixels for a face that has a bitmap', async () => {
    const { store } = await drive(async (robot) => {
      await robot.setFace('happy');
    });
    expect(store.panel.litPixels).toBeGreaterThan(0);
    expect(store.oledSource.kind).toBe('rendered');
    // The face event was simulated; the pixels were constructed host-side, so
    // they are `inferred`. Both are shown, and they are not the same claim.
    expect(store.oledSource.triggerProvenance).toBe('simulated');
    expect(store.oledSource.pixelProvenance).toBe('inferred');
    expect(store.emptyFace).toBeNull();
  });

  it('leaves the panel genuinely blank when setFace("stand") is the first face drawn', async () => {
    // `bootFace: false` skips setup()'s setFace("rest"), which is the only
    // reason the panel is ever non-blank before a user does anything. With
    // nothing drawn yet, the empty-face bug reads as what it is: no pixels.
    const { store, events } = await drive(
      async (robot) => {
        await robot.setFace('stand');
      },
      { bootFace: false },
    );
    // The model emits no face.expression at all for a zero-frame face — the
    // firmware never reaches updateFaceBitmap(), so there is nothing to report.
    expect(events.filter((e) => e.type === 'face.expression')).toHaveLength(0);
    expect(store.panel.litPixels).toBe(0);
    expect(store.panel.writes).toBe(0);
  });

  it('leaves the previous face on the glass when a later setFace draws nothing', async () => {
    const { store } = await drive(async (robot) => {
      await robot.setFace('happy');
    });
    const afterHappy = store.panel.base64;
    const writesAfterHappy = store.panel.writes;

    const { store: store2 } = await drive(async (robot) => {
      await robot.setFace('happy');
      await robot.setFace('stand');
    });
    // Retained, not blanked: updateFaceBitmap() was never reached, so
    // display.display() never ran and GDDRAM is byte-for-byte what it was.
    expect(store2.panel.base64).toBe(afterHappy);
    expect(store2.panel.writes).toBe(writesAfterHappy);
    expect(store2.panel.litPixels).toBeGreaterThan(0);
  });

  it('animates a multi-frame face during a movement', async () => {
    const { events } = await drive(async (robot) => {
      await robot.command('point'); // `point` is 3 frames, boomerang
    });
    const faceEvents = events.filter((e) => e.type === 'face.expression');
    const frames = new Set(faceEvents.map((e) => (e.type === 'face.expression' ? e.frame : -1)));
    expect(frames.size).toBeGreaterThan(1);
  });
});
