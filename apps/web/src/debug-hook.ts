/**
 * `window.__sesame` — the surface the headless browser test drives and reads.
 *
 * Phase 0 established the rule this file exists to satisfy: **a browser claim
 * is not evidence until a browser has been driven headlessly.** The
 * corollary that shapes the API is that reading a React state value back out
 * would prove nothing — React can be perfectly correct while three.js renders
 * nothing at all. So every geometric accessor here goes to the **scene graph**:
 * `Object3D.quaternion`, `BufferGeometry` vertex positions, `matrixWorld`. If
 * the transform did not reach three.js, these numbers do not move.
 *
 * It is a debug surface, not an API: it is attached unconditionally because the
 * evidence it produces is part of the deliverable, and it exposes nothing a
 * user could not do with the buttons.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import type { Provenance } from '@sesame-lab/sesame-protocol';
import { Mesh, Quaternion, Vector3 } from 'three';

import type { BackendId, BackendStatus } from './backends/types.js';
import type { TelemetryStore } from './state/telemetry-store.js';
import type { WorldFrameReading } from './three/RobotScene.js';
import {
  commandedDegFromNode,
  computeGroundPlaneMm,
  expectedQuaternion,
  MM_PER_UNIT,
  quaternionAngleDeg,
  type AssetFacts,
  type JointRig,
} from './three/rig.js';

export interface SceneJointReading {
  readonly joint: JointName;
  readonly firmwareIndex: number;
  /** Straight off `Object3D.quaternion`. */
  readonly quaternion: [number, number, number, number];
  /** The commanded angle recovered from that quaternion. */
  readonly sceneCommandedDeg: number;
  /** What the store thinks, for comparison. `null` = never commanded. */
  readonly storeCommandedDeg: number | null;
  /** World position of the node's origin, in canonical millimetres. */
  readonly pivotWorldMm: [number, number, number];
}

export interface StandPoseVerification {
  readonly ok: boolean;
  readonly referencePose: string;
  readonly maxJointAngleErrorDeg: number;
  readonly perJoint: readonly {
    joint: JointName;
    expectedDeg: number;
    storeCommandedDeg: number | null;
    sceneCommandedDeg: number;
    quaternionErrorDeg: number;
  }[];
  /** Recomputed in-browser from the posed foot vertices. */
  readonly groundPlaneMm: number | null;
  /** What V2 recorded for this pose. */
  readonly v2GroundPlaneMm: number;
  readonly groundPlaneResidualMm: number | null;
  readonly problems: readonly string[];
}

export interface SesameDebugApi {
  readonly ready: boolean;
  backendId(): BackendId;
  status(): BackendStatus;
  setBackend(id: BackendId, url?: string): Promise<void>;
  run(command: string): Promise<void>;
  setFace(name: string): Promise<void>;
  setJoint(joint: JointName, deg: number): Promise<void>;
  stop(): void;
  reset(): void;
  /** Scene-graph readings for all eight joints. */
  sceneJoints(): SceneJointReading[];
  /** Recomputed from the posed foot meshes. Pose-dependent, by definition. */
  groundPlaneMm(): number | null;
  /**
   * The world frame, off `matrixWorld` — the things that must NOT move.
   *
   * `sceneJoints()` proves the pose reached three.js. It cannot prove the
   * world stayed still while it did, and that gap is exactly what let
   * ISSUE-20260823-023 ship: eight perfectly correct joint rotations and a
   * floor sliding 37.5 mm underneath them. Poll this across a movement and
   * every field except `footContactMm` must come back bit-identical.
   */
  worldFrame(): WorldFrameReading | null;
  verifyStandPose(): StandPoseVerification;
  oled(): {
    base64: string;
    litPixels: number;
    writes: number;
    face: { name: string; frame: number; provenance: Provenance } | null;
    source: { kind: string; pixelProvenance: Provenance | null; triggerProvenance: Provenance | null };
    emptyFace: { requested: string; reason: string } | null;
    /** `oled_screen`'s material actually carries a texture whose image is our canvas. */
    projectedIn3d: boolean;
    textureFlipY: boolean | null;
  };
  provenance(): { driving: Provenance | null; counts: Record<Provenance, number>; totalEvents: number };
  assetFacts(): AssetFacts | null;
  /** Frames drawn and pose version applied — proof the render loop is alive. */
  renderStats(): { frames: number; appliedPoseVersion: number; storePoseVersion: number } | null;
  /** Everything at once, for a single CDP round trip. */
  snapshot(): Record<string, unknown>;
}

export interface DebugHookWiring {
  readonly store: TelemetryStore;
  rig(): Record<JointName, JointRig> | null;
  facts(): AssetFacts | null;
  renderStats(): { frames: number; appliedPoseVersion: number } | null;
  worldFrame(): WorldFrameReading | null;
  oledCanvas(): HTMLCanvasElement;
  backendId(): BackendId;
  status(): BackendStatus;
  setBackend(id: BackendId, url?: string): Promise<void>;
  run(command: string): Promise<void>;
  setFace(name: string): Promise<void>;
  setJoint(joint: JointName, deg: number): Promise<void>;
  stop(): void;
  reset(): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __sesame: SesameDebugApi | undefined;
}

export function installDebugHook(wiring: DebugHookWiring): () => void {
  const api: SesameDebugApi = {
    get ready() {
      return wiring.rig() !== null;
    },
    backendId: () => wiring.backendId(),
    status: () => wiring.status(),
    setBackend: (id, url) => wiring.setBackend(id, url),
    run: (command) => wiring.run(command),
    setFace: (name) => wiring.setFace(name),
    setJoint: (joint, deg) => wiring.setJoint(joint, deg),
    stop: () => wiring.stop(),
    reset: () => wiring.reset(),

    sceneJoints(): SceneJointReading[] {
      const rig = wiring.rig();
      if (rig === null) return [];
      const world = new Vector3();
      return JOINT_ORDER.map((joint) => {
        const entry = rig[joint];
        entry.node.updateWorldMatrix(true, false);
        entry.node.getWorldPosition(world);
        const q = entry.node.quaternion;
        return {
          joint,
          firmwareIndex: entry.firmwareIndex,
          quaternion: [q.x, q.y, q.z, q.w],
          sceneCommandedDeg: commandedDegFromNode(entry),
          storeCommandedDeg: wiring.store.joints[joint].commandedDeg,
          pivotWorldMm: [world.x * MM_PER_UNIT, world.y * MM_PER_UNIT, world.z * MM_PER_UNIT],
        };
      });
    },

    groundPlaneMm(): number | null {
      const rig = wiring.rig();
      return rig === null ? null : computeGroundPlaneMm(rig);
    },

    worldFrame: () => wiring.worldFrame(),

    /**
     * The end-to-end check: choreography → sim → GLB → scene graph.
     *
     * V2's claim is that driving this rig to `runStandPose`'s commanded angles
     * reproduces V0's own part placements to 2.065e-6 mm per vertex, measured
     * through the written GLB. That measurement is not reproducible in a
     * browser — it needs the raw STLs, which are not shipped to the client. So
     * this checks the same chain at the two places a browser *can* see it:
     *
     * 1. every joint node's quaternion equals the one V2's own pose rule
     *    predicts for the reference pose stored in the asset — which tests that
     *    the choreography the sim executed and the angles the asset was built
     *    around are the same eight numbers, and that they survived the trip
     *    into three.js;
     * 2. the ground plane, recomputed here from the posed foot vertices by V2's
     *    stated method, matches the value V2 recorded for this pose. That one
     *    is geometric: it depends on the mesh data, the pivots, the parenting,
     *    the axes and the signs all being right together.
     */
    verifyStandPose(): StandPoseVerification {
      const rig = wiring.rig();
      const facts = wiring.facts();
      const problems: string[] = [];

      if (rig === null || facts === null) {
        return {
          ok: false,
          referencePose: '(not loaded)',
          maxJointAngleErrorDeg: Number.NaN,
          perJoint: [],
          groundPlaneMm: null,
          v2GroundPlaneMm: Number.NaN,
          groundPlaneResidualMm: null,
          problems: ['the scene has not finished loading'],
        };
      }

      const reference = facts.referencePose.commandedDeg;
      const actual = new Quaternion();
      let maxError = 0;

      const perJoint = JOINT_ORDER.map((joint) => {
        const entry = rig[joint];
        const expectedDeg = reference[joint];
        if (typeof expectedDeg !== 'number') {
          problems.push(`the asset's referencePose has no angle for ${joint}`);
        }
        const target = expectedQuaternion(entry, expectedDeg ?? 90);
        actual.copy(entry.node.quaternion);
        const error = quaternionAngleDeg(actual, target);
        if (error > maxError) maxError = error;
        return {
          joint,
          expectedDeg: expectedDeg ?? Number.NaN,
          storeCommandedDeg: wiring.store.joints[joint].commandedDeg,
          sceneCommandedDeg: commandedDegFromNode(entry),
          quaternionErrorDeg: error,
        };
      });

      // Float32 quaternion storage in the GLB plus a degrees→radians round trip.
      // 1e-3 deg is ~17 microradians: far tighter than anything visible, far
      // looser than float32 noise.
      if (maxError > 1e-3) {
        problems.push(
          `joint rotations differ from the asset's own reference pose by up to ${maxError.toExponential(3)}°`,
        );
      }

      const groundPlaneMm = computeGroundPlaneMm(rig);
      const v2GroundPlaneMm = facts.groundPlane.atRunStandPoseMm;
      const residual = groundPlaneMm === null ? null : groundPlaneMm - v2GroundPlaneMm;
      // The GLB stores positions as float32 over a ~130 mm robot, so ~1e-5 mm
      // is the storage floor; 1e-3 mm is a comfortable ceiling that would still
      // catch a wrong sign, a wrong axis or a dropped parent.
      if (residual === null || Math.abs(residual) > 1e-3) {
        problems.push(
          `the ground plane recomputed from the posed feet is ${groundPlaneMm?.toFixed(6) ?? 'null'} mm; ` +
            `V2 recorded ${v2GroundPlaneMm.toFixed(6)} mm for this pose`,
        );
      }

      return {
        ok: problems.length === 0,
        referencePose: facts.referencePose.identifiedAs,
        maxJointAngleErrorDeg: maxError,
        perJoint,
        groundPlaneMm,
        v2GroundPlaneMm,
        groundPlaneResidualMm: residual,
        problems,
      };
    },

    oled() {
      const store = wiring.store;
      const rig = wiring.rig();
      const canvas = wiring.oledCanvas();

      let projectedIn3d = false;
      let textureFlipY: boolean | null = null;
      const root = rig === null ? null : rig.R1.node.parent;
      const node = root?.getObjectByName('oled_screen');
      if (node instanceof Mesh && !Array.isArray(node.material)) {
        const map = (node.material as { map?: { image?: unknown; flipY?: boolean } }).map;
        if (map !== undefined && map !== null) {
          projectedIn3d = map.image === canvas;
          textureFlipY = map.flipY ?? null;
        }
      }

      return {
        base64: store.panel.base64,
        litPixels: store.panel.litPixels,
        writes: store.panel.writes,
        face:
          store.face === null
            ? null
            : { name: store.face.name, frame: store.face.frame, provenance: store.face.provenance },
        source: {
          kind: store.oledSource.kind,
          pixelProvenance: store.oledSource.pixelProvenance,
          triggerProvenance: store.oledSource.triggerProvenance,
        },
        emptyFace:
          store.emptyFace === null
            ? null
            : { requested: store.emptyFace.requested, reason: store.emptyFace.reason },
        projectedIn3d,
        textureFlipY,
      };
    },

    provenance() {
      return {
        driving: wiring.store.drivingProvenance,
        counts: { ...wiring.store.provenanceCounts },
        totalEvents: wiring.store.totalEvents,
      };
    },

    assetFacts: () => wiring.facts(),

    renderStats() {
      const stats = wiring.renderStats();
      return stats === null ? null : { ...stats, storePoseVersion: wiring.store.poseVersion };
    },

    snapshot() {
      return {
        ready: api.ready,
        renderStats: api.renderStats(),
        backend: wiring.backendId(),
        status: wiring.status(),
        sceneJoints: api.sceneJoints(),
        groundPlaneMm: api.groundPlaneMm(),
        worldFrame: api.worldFrame(),
        oled: api.oled(),
        provenance: api.provenance(),
        face: wiring.store.face,
        canvasPixels: canvasPixelCount(),
      };
    },
  };

  globalThis.__sesame = api;
  return () => {
    if (globalThis.__sesame === api) globalThis.__sesame = undefined;
  };
}

/**
 * How many non-background pixels the WebGL canvas is actually showing.
 *
 * The cheapest possible answer to "did the browser render anything at all",
 * and the one thing a screenshot assertion cannot fake: it reads the drawing
 * buffer back, which is why the canvas is created with `preserveDrawingBuffer`.
 *
 * The renderer's canvas is found by asking each `<canvas>` on the page for a
 * WebGL context — the OLED panel's canvas is a 2D one and answers `null`, so
 * there is no need to depend on a class name R3F may or may not forward.
 */
function canvasPixelCount(): number | null {
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  for (const candidate of document.querySelectorAll('canvas')) {
    const context = candidate.getContext('webgl2') ?? candidate.getContext('webgl');
    if (context !== null) {
      canvas = candidate;
      gl = context;
      break;
    }
  }
  if (canvas === null || gl === null) return null;
  const width = Math.min(canvas.width, 320);
  const height = Math.min(canvas.height, 320);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // The clear colour is #0d1015.
    if (Math.abs((pixels[i] ?? 0) - 0x0d) > 6 || Math.abs((pixels[i + 1] ?? 0) - 0x10) > 6 || Math.abs((pixels[i + 2] ?? 0) - 0x15) > 6) {
      n += 1;
    }
  }
  return n;
}
