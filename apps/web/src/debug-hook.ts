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
import type { OriginKind, Provenance, TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import { Mesh, Object3D, Quaternion, Vector3 } from 'three';

import type { BackendId, BackendStatus, EmulatorFacts } from './backends/types.js';
import { layoutArchitecture } from './arch/layout.js';
import { ARCH_NODES, HAND_AUTHORED, UPSTREAM_COMMIT } from './generated/architecture-graph.js';
import { ANNOTATIONS_UPSTREAM_COMMIT, CURRICULUM } from './generated/source-annotations.js';
import { archNodesInSymbol, citationsForSymbol, SYMBOL_BY_ID } from './source/model.js';
import { LESSONS, POLISHED_LESSON_IDS } from './generated/lessons.js';
import { IMPLEMENTED_CHECKS, IMPLEMENTED_CONTROLS, UNIMPLEMENTED_CONTROLS } from './lessons/registry.js';
import type { LessonRuntime } from './lessons/runtime.js';
import type { SelectionState } from './state/selection.js';
import type { TelemetryStore } from './state/telemetry-store.js';
import { traceBadge, type TraceStore } from './state/trace-store.js';
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
  /** Provenance of the event that last moved this node. */
  readonly storeProvenance: Provenance | null;
  /**
   * Which boundary that event crossed — `'emulator'` when real firmware under
   * QEMU produced it. This is what makes "a browser button drove real firmware"
   * assertable rather than merely screenshot-able.
   */
  readonly storeOriginKind: OriginKind | null;
  /** `isPhysicallyObserved()` on that event. Never true in this project. */
  readonly storePhysicallyObserved: boolean;
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

/**
 * One "See the Signal" row, flattened for the headless harness.
 *
 * `badge` is the string the UI actually renders, computed by the same
 * `traceBadge()` the panel uses — so an assertion on it is an assertion about
 * what a learner sees, not about an internal field the UI might ignore.
 */
export interface TraceRowReading {
  readonly layer: string;
  /** Position in the causal ladder. `ui.command` is 0, `visual.joint` is 7. */
  readonly rank: number;
  readonly label: string;
  readonly provenance: Provenance;
  readonly originKind: OriginKind | null;
  /** `isPhysicallyObserved()` on the row. Must be false for every row, always. */
  readonly physicallyObserved: boolean;
  readonly badge: string;
  /** `trace-id` (causal) vs `time-window` (correlation) vs `app-local`. */
  readonly match: string;
  readonly joint: JointName | null;
  readonly nodeId: string | null;
  readonly seq: number | null;
}

export interface TraceReading {
  readonly id: string;
  readonly command: string;
  readonly backendId: BackendId;
  /** True when events came back carrying this trace's id. */
  readonly carriedTraceId: boolean;
  readonly windowAdopted: number;
  readonly rows: readonly TraceRowReading[];
}

/**
 * Selection, read out of the **three.js materials** rather than out of React.
 *
 * The whole point of `sceneJoints()` is that a React state value proves
 * nothing about what was drawn, and cross-pane highlighting is no different: a
 * `selected` prop can be perfectly correct while the mesh stays unlit. So this
 * reads `MeshStandardMaterial.emissiveIntensity` off the joint subtrees. If the
 * highlight did not reach three.js, these numbers stay zero.
 */
export interface SceneSelectionReading {
  /** What the app thinks is selected. */
  readonly joint: JointName | null;
  readonly nodeId: string | null;
  /** Peak emissive intensity found under each joint node. */
  readonly emissiveByJoint: Record<JointName, number>;
  /** Joints actually lit in the scene graph. Should equal `[joint]` or `[]`. */
  readonly litJoints: readonly JointName[];
}

/** What the architecture pane is currently drawing. */
export interface ArchGraphReading {
  readonly upstreamCommit: string;
  readonly totalNodes: number;
  readonly visibleNodeIds: readonly string[];
  readonly expanded: readonly string[];
  readonly edges: readonly { source: string; target: string; lifted: boolean }[];
  /** Node ids rendered with the selected/related treatment. */
  readonly selectedNodeId: string | null;
  /** Claims no artefact in this repository establishes. */
  readonly handAuthored: readonly string[];
  /** Nodes whose value is recorded as unresolved in hardware-map.json. */
  readonly unresolvedNodeIds: readonly string[];
}

/**
 * What the source pane is actually SHOWING, read out of the DOM.
 *
 * Deliberately the DOM and not the component's state, for the same reason
 * `sceneJoints()` reads `Object3D.quaternion` rather than the store: the claim
 * under test is "the learner is looking at line 91 of the pinned tree", and a
 * correct `startLine` in React proves nothing about what was drawn.
 *
 * `renderedStartLineText` is the sharp end. It is the text the browser painted
 * on the line numbered `symbol.startLine`; comparing it against the
 * `startLineText` L3 recorded catches a drifted file, a wrong tree and an
 * off-by-one window in one assertion.
 */
export interface SourceExplorerReading {
  readonly upstreamCommit: string;
  /** `ok` | `loading` | `missing` | `mismatch` | `error`, off `data-status`. */
  readonly integrity: string | null;
  /** The file tab that is active. */
  readonly file: string | null;
  readonly symbolId: string | null;
  readonly symbol: {
    readonly id: string;
    readonly kind: string;
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly startLineText: string;
    readonly endLineText: string;
    readonly robotParts: readonly string[];
    readonly concepts: readonly string[];
    readonly teachingNotes: readonly string[];
  } | null;
  /** Line numbers actually painted, first and last. */
  readonly renderedFirstLine: number | null;
  readonly renderedLastLine: number | null;
  readonly renderedLineCount: number;
  /**
   * The painted text of `symbol.startLine`, exactly as the browser has it.
   *
   * `null` when the open file is not the selected symbol's file: line 91 of
   * another file is not this symbol's first line, and saying so would be worse
   * than saying nothing.
   */
  readonly renderedStartLineText: string | null;
  readonly renderedEndLineText: string | null;
  /** Lines the pane marked as cited by some artefact. */
  readonly citedLines: readonly number[];
  /** What the annotations say should be cited. Compare against the above. */
  readonly expectedCitedLines: readonly number[];
  /** Architecture nodes whose `sourceRef` lands inside the selected symbol. */
  readonly archNodesInSymbol: readonly string[];
  /** Symbol ids in the outline, in reading order. */
  readonly outlineSymbolIds: readonly string[];
  /** Trace rows the pane says ran inside this span. */
  readonly runtimeRowLayers: readonly string[];
  /** Which explanatory level the concept panel is showing. One, never three. */
  readonly conceptLevelShown: string | null;
  readonly conceptId: string | null;
  readonly conceptDensity: number | null;
  /** Curriculum modules on screen that carry the `conceptual` badge. */
  readonly conceptualModulesOnScreen: readonly string[];
  /** Total `grounding: "conceptual"` modules in the artefact. Must be 7. */
  readonly conceptualModulesTotal: number;
  /** True when the pane painted code lines. False unless `integrity === "ok"`. */
  readonly renderedAnySource: boolean;
}

/**
 * What Learn mode is showing, read off the DOM.
 *
 * DOM and not React state, for the same reason phase 1 reads
 * `Object3D.quaternion` rather than the store: React can be perfectly correct
 * while nothing is rendered, and a lesson runner that reports a step passed
 * which it never painted is precisely the failure this feature cannot have.
 */
export interface LessonReading {
  readonly openLessonId: string | null;
  readonly outlineMode: boolean;
  readonly claimDomain: string | null;
  /** The `conceptual` banner. Driven by `grounding`, never by symbol count. */
  readonly conceptualBadge: boolean;
  readonly groundingNote: boolean;
  readonly stepId: string | null;
  readonly stepKind: string | null;
  readonly checkType: string | null;
  readonly checkStatus: string | null;
  readonly checkSummary: string | null;
  readonly checkExpected: string | null;
  readonly checkObserved: string | null;
  readonly skipped: boolean;
  /** MUST be 1 while a step is open. Three levels; one on screen. */
  readonly explanationCount: number;
  readonly shownLevel: string | null;
  /** `null` when the step has no goDeeper; otherwise whether it is expanded. */
  readonly goDeeperOpen: boolean | null;
  readonly boundaryNoteCount: number;
  readonly boundaryDomains: readonly string[];
  readonly observability: string | null;
  readonly controlKind: string | null;
  /** Non-null when the control refused to render because it is not built. */
  readonly controlNotBuilt: string | null;
  readonly stepOutcomes: readonly { readonly id: string; readonly outcome: string }[];
  readonly challenges: readonly {
    readonly id: string;
    readonly unlocked: boolean;
    readonly status: string;
  }[];
  readonly lessonCards: readonly {
    readonly id: string;
    readonly grounding: string;
    readonly status: string;
    readonly locked: boolean;
    readonly conceptualBadge: boolean;
  }[];
  /** The declared faults as rendered, split by `injectorIsLabFeature`. */
  readonly faults: readonly { readonly id: string; readonly injected: boolean }[];
  readonly implementedControls: readonly string[];
  readonly unimplementedControls: readonly string[];
  readonly implementedChecks: readonly string[];
  readonly polishedLessonIds: readonly string[];
  readonly lessonCount: number;
  /** Journal sizes, so a phase can tell "nothing happened" from "nothing seen". */
  readonly journal: { readonly events: number; readonly actions: number; readonly visits: number };
}

export interface SesameDebugApi {
  readonly ready: boolean;
  backendId(): BackendId;
  status(): BackendStatus;
  /** The backend's emulator qualifiers, or `null` if it is not an emulator. */
  emulatorFacts(): EmulatorFacts | null;
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
  /**
   * The second axis, exposed separately so a harness cannot accidentally assert
   * "observed" and believe it proved "measured".
   */
  origin(): {
    driving: TelemetryOrigin | null;
    counts: Record<OriginKind, number>;
    /** `isPhysicallyObserved()` was true this many times. Must be 0. */
    physicallyObservedEvents: number;
  };
  /** The current cross-pane selection. One object, four panes. */
  selection(): SelectionState;
  /** Select a joint as if it had been clicked in the 3D scene. */
  selectJoint(joint: JointName | null): void;
  /** Select an architecture node as if it had been clicked in the graph. */
  selectNode(nodeId: string | null): void;
  /** Select an annotated source symbol as if it had been clicked in the outline. */
  selectSymbol(symbolId: string | null): void;
  /** Expand or collapse one architecture node. */
  toggleNode(id: string): void;
  /** Which joint the 3D scene is actually lighting, off the materials. */
  sceneSelection(): SceneSelectionReading;
  /** What the architecture pane is drawing right now. */
  archGraph(): ArchGraphReading;
  /** What the source pane is drawing right now, read out of the DOM. */
  sourceExplorer(): SourceExplorerReading;
  /** Learn mode, read off the DOM. */
  lessons(): LessonReading;
  /** The trace on screen, in causal order. `null` before any command. */
  trace(): TraceReading | null;
  assetFacts(): AssetFacts | null;
  /** Frames drawn and pose version applied — proof the render loop is alive. */
  renderStats(): { frames: number; appliedPoseVersion: number; storePoseVersion: number } | null;
  /** Everything at once, for a single CDP round trip. */
  snapshot(): Record<string, unknown>;
}

export interface DebugHookWiring {
  readonly store: TelemetryStore;
  /** Learn mode’s journal, so a harness can tell "nothing happened" from "nothing was seen". */
  readonly lessonRuntime: LessonRuntime;
  readonly traceStore: TraceStore;
  selection(): SelectionState;
  selectJoint(joint: JointName | null): void;
  selectNode(nodeId: string | null): void;
  selectSymbol(symbolId: string | null): void;
  expanded(): readonly string[];
  toggleNode(id: string): void;
  rig(): Record<JointName, JointRig> | null;
  facts(): AssetFacts | null;
  renderStats(): { frames: number; appliedPoseVersion: number } | null;
  worldFrame(): WorldFrameReading | null;
  oledCanvas(): HTMLCanvasElement;
  backendId(): BackendId;
  status(): BackendStatus;
  emulatorFacts(): EmulatorFacts | null;
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
    emulatorFacts: () => wiring.emulatorFacts(),
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
        const view = wiring.store.joints[joint];
        entry.node.updateWorldMatrix(true, false);
        entry.node.getWorldPosition(world);
        const q = entry.node.quaternion;
        return {
          joint,
          firmwareIndex: entry.firmwareIndex,
          quaternion: [q.x, q.y, q.z, q.w],
          sceneCommandedDeg: commandedDegFromNode(entry),
          storeCommandedDeg: view.commandedDeg,
          storeProvenance: view.provenance,
          storeOriginKind: view.origin?.kind ?? null,
          storePhysicallyObserved: view.physicallyObserved,
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

    origin() {
      return {
        driving: wiring.store.drivingOrigin,
        counts: { ...wiring.store.originCounts },
        physicallyObservedEvents: wiring.store.physicallyObservedEvents,
      };
    },

    selection: () => wiring.selection(),
    selectJoint: (joint) => wiring.selectJoint(joint),
    selectNode: (nodeId) => wiring.selectNode(nodeId),
    selectSymbol: (symbolId) => wiring.selectSymbol(symbolId),
    toggleNode: (id) => wiring.toggleNode(id),

    sceneSelection(): SceneSelectionReading {
      const rig = wiring.rig();
      const selection = wiring.selection();
      const emissiveByJoint = Object.fromEntries(JOINT_ORDER.map((j) => [j, 0])) as Record<
        JointName,
        number
      >;
      if (rig !== null) {
        // Attribute each mesh to its NEAREST joint ancestor, not to every joint
        // above it. The rig is parented — R4's foot lives inside R2's femur
        // subtree — so a naive `rig[joint].node.traverse()` reports R2 as lit
        // whenever R4 is, and the cross-link assertion would pass on a
        // highlight that never reached the joint the learner clicked.
        const owners = new Map<string, JointName>();
        for (const joint of JOINT_ORDER) owners.set(rig[joint].node.uuid, joint);
        const nearestJoint = (node: Object3D): JointName | null => {
          let cursor: Object3D | null = node;
          while (cursor !== null) {
            const owner = owners.get(cursor.uuid);
            if (owner !== undefined) return owner;
            cursor = cursor.parent;
          }
          return null;
        };
        for (const joint of JOINT_ORDER) {
          let peak = 0;
          rig[joint].node.traverse((child) => {
            if (!(child instanceof Mesh)) return;
            if (nearestJoint(child) !== joint) return;
            const material = child.material;
            if (Array.isArray(material)) return;
            const intensity = (material as { emissiveIntensity?: number }).emissiveIntensity;
            if (typeof intensity === 'number' && intensity > peak) peak = intensity;
          });
          emissiveByJoint[joint] = peak;
        }
      }
      return {
        joint: selection.joint,
        nodeId: selection.nodeId,
        emissiveByJoint,
        litJoints: JOINT_ORDER.filter((j) => emissiveByJoint[j] > 0),
      };
    },

    /**
     * Read the architecture pane back the way the scene-graph accessors read
     * three.js: from the layout the component actually renders, not from the
     * generated data. A node that is in `ARCH_NODES` but not laid out is not on
     * screen, and this must be able to tell those apart.
     */
    archGraph(): ArchGraphReading {
      const expandedIds = wiring.expanded();
      const layout = layoutArchitecture(new Set(expandedIds));
      return {
        upstreamCommit: UPSTREAM_COMMIT,
        totalNodes: ARCH_NODES.length,
        visibleNodeIds: layout.nodes.map((n) => n.node.id),
        expanded: [...expandedIds],
        edges: layout.edges.map((e) => ({ source: e.source, target: e.target, lifted: e.lifted })),
        selectedNodeId: wiring.selection().nodeId,
        handAuthored: [...HAND_AUTHORED],
        unresolvedNodeIds: ARCH_NODES.filter((n) => n.unresolved !== null).map((n) => n.id),
      };
    },

    lessons(): LessonReading {
      const panel = document.querySelector('[data-testid="lesson-runner"]');
      const q = (selector: string): Element | null => panel?.querySelector(selector) ?? null;
      const all = (selector: string): Element[] =>
        panel === null ? [] : [...panel.querySelectorAll(selector)];
      const attr = (selector: string, name: string): string | null =>
        q(selector)?.getAttribute(name) ?? null;
      const textOf = (selector: string): string | null => q(selector)?.textContent?.trim() ?? null;

      const check = q('[data-testid="lesson-check"]');
      const godeeper = q('[data-testid="lesson-godeeper"]');

      return {
        openLessonId: panel?.getAttribute('data-lesson') ?? null,
        outlineMode: q('[data-testid="lesson-outline"]') !== null,
        claimDomain: attr('[data-testid="lesson-claim"]', 'data-claim-domain'),
        conceptualBadge: q('[data-testid="lesson-conceptual-badge"]') !== null,
        groundingNote: q('[data-testid="lesson-grounding-note"]') !== null,
        stepId: attr('[data-testid="lesson-step"]', 'data-step'),
        stepKind: attr('[data-testid="lesson-step"]', 'data-kind'),
        checkType: check?.getAttribute('data-check-type') ?? null,
        checkStatus: check?.getAttribute('data-status') ?? null,
        checkSummary: textOf('[data-testid="lesson-check-summary"]'),
        checkExpected: textOf('[data-testid="lesson-check-expected"]'),
        checkObserved: textOf('[data-testid="lesson-check-observed"]'),
        skipped: check?.getAttribute('data-skipped') === 'true',
        // The assertion the report asks for: three levels, exactly one shown.
        explanationCount: all('[data-testid="lesson-explanation"]').length,
        shownLevel: attr('[data-testid="lesson-explanation"]', 'data-shown-level'),
        goDeeperOpen: godeeper === null ? null : (godeeper as HTMLDetailsElement).open,
        boundaryNoteCount: all('[data-testid="lesson-boundary-note"]').length,
        boundaryDomains: all('[data-testid="lesson-boundary-note"]').map(
          (node) => node.getAttribute('data-domain') ?? '',
        ),
        observability: textOf('[data-testid="lesson-observability"]'),
        controlKind: attr('[data-testid="lesson-control"]', 'data-control'),
        controlNotBuilt: attr('[data-testid="lesson-control-notbuilt"]', 'data-control-kind'),
        stepOutcomes: all('[data-outcome]').map((node) => ({
          id: node.getAttribute('data-testid')?.replace('lesson-step-', '') ?? '',
          outcome: node.getAttribute('data-outcome') ?? '',
        })),
        challenges: all('[data-unlocked]').map((node) => ({
          id: node.getAttribute('data-testid')?.replace('challenge-', '') ?? '',
          unlocked: node.getAttribute('data-unlocked') === 'true',
          status: node.getAttribute('data-status') ?? '',
        })),
        lessonCards: all('[data-locked]').map((node) => ({
          id: node.getAttribute('data-testid')?.replace('lesson-card-', '') ?? '',
          grounding: node.getAttribute('data-grounding') ?? '',
          status: node.getAttribute('data-status') ?? '',
          locked: node.getAttribute('data-locked') === 'true',
          conceptualBadge: node.querySelector('[data-testid^="conceptual-"]') !== null,
        })),
        faults: all('[data-fault]').map((node) => ({
          id: node.getAttribute('data-fault') ?? '',
          injected: node.getAttribute('data-injected') === 'true',
        })),
        implementedControls: [...IMPLEMENTED_CONTROLS],
        unimplementedControls: [...UNIMPLEMENTED_CONTROLS],
        implementedChecks: [...IMPLEMENTED_CHECKS],
        polishedLessonIds: [...POLISHED_LESSON_IDS],
        lessonCount: LESSONS.length,
        journal: {
          events: wiring.lessonRuntime.events.length,
          actions: wiring.lessonRuntime.actions.length,
          visits: wiring.lessonRuntime.symbolVisits.length,
        },
      };
    },

    sourceExplorer(): SourceExplorerReading {
      const panel = document.querySelector('[data-testid="source-explorer"]');
      const symbolId = wiring.selection().symbolId;
      const symbol = symbolId === null ? undefined : SYMBOL_BY_ID.get(symbolId);
      const query = (selector: string): Element[] =>
        panel === null ? [] : [...panel.querySelectorAll(selector)];
      const attrs = (selector: string, name: string): string[] =>
        query(selector)
          .map((node) => node.getAttribute(name) ?? '')
          .filter((value) => value.length > 0);

      const lineNumbers = attrs('[data-line]', 'data-line')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));

      // The painted text of one numbered line. `.src-text` excludes the gutter
      // number, so this is the source line and nothing else.
      const textOfLine = (line: number): string | null => {
        const node =
          panel?.querySelector('[data-line="' + String(line) + '"] .src-text') ?? null;
        return node === null ? null : (node.textContent ?? '');
      };

      const cited = attrs('[data-cited="true"]', 'data-line')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));

      const conceptPanel = panel?.querySelector('[data-testid="source-concepts"]') ?? null;
      const conceptText = panel?.querySelector('[data-testid="concept-text"]') ?? null;
      const densityNode = panel?.querySelector('[data-testid="concept-density"]') ?? null;

      // The learner can open a file the selected symbol does not live in. When
      // they have, the pane is not showing that symbol, and reporting a line
      // text for it would be reading line 91 of the wrong file.
      const activeFile =
        panel?.querySelector('.source-tab.active')?.getAttribute('data-source-file') ?? null;
      const symbolInView = symbol !== undefined && symbol.file === activeFile;

      return {
        upstreamCommit: ANNOTATIONS_UPSTREAM_COMMIT,
        integrity:
          panel?.querySelector('[data-testid="source-integrity"]')?.getAttribute('data-status') ??
          null,
        file: activeFile,
        symbolId,
        symbol:
          symbol === undefined
            ? null
            : {
                id: symbol.id,
                kind: symbol.kind,
                file: symbol.file,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                startLineText: symbol.startLineText,
                endLineText: symbol.endLineText,
                robotParts: [...symbol.robotParts],
                concepts: [...symbol.concepts],
                teachingNotes: [...symbol.teachingNotes],
              },
        renderedFirstLine: lineNumbers.length === 0 ? null : Math.min(...lineNumbers),
        renderedLastLine: lineNumbers.length === 0 ? null : Math.max(...lineNumbers),
        renderedLineCount: lineNumbers.length,
        renderedStartLineText: symbolInView ? textOfLine(symbol.startLine) : null,
        renderedEndLineText: symbolInView ? textOfLine(symbol.endLine) : null,
        citedLines: [...new Set(cited)].sort((a, b) => a - b),
        expectedCitedLines:
          symbol === undefined ? [] : [...citationsForSymbol(symbol).keys()].sort((a, b) => a - b),
        archNodesInSymbol: archNodesInSymbol(symbolId).map((node) => node.id),
        outlineSymbolIds: attrs('[data-source-symbol]', 'data-source-symbol'),
        runtimeRowLayers: attrs('[data-source-trace-row]', 'data-layer'),
        conceptLevelShown: conceptText?.getAttribute('data-shown-level') ?? null,
        conceptId: conceptPanel?.getAttribute('data-concept') ?? null,
        conceptDensity: densityNode === null ? null : Number(densityNode.textContent ?? '0'),
        conceptualModulesOnScreen: attrs('[data-grounding="conceptual"]', 'data-module'),
        conceptualModulesTotal: CURRICULUM.filter((m) => m.grounding === 'conceptual').length,
        renderedAnySource: lineNumbers.length > 0,
      };
    },

    trace(): TraceReading | null {
      const active = wiring.traceStore.active;
      if (active === null) return null;
      return {
        id: active.id,
        command: active.command,
        backendId: active.backendId,
        carriedTraceId: active.carriedTraceId,
        windowAdopted: active.windowAdopted,
        rows: active.rows.map((row) => ({
          layer: row.layer,
          rank: row.rank,
          label: row.label,
          provenance: row.provenance,
          originKind: row.origin?.kind ?? null,
          physicallyObserved: row.physicallyObserved,
          badge: traceBadge(row).text,
          match: row.match,
          joint: row.joint,
          nodeId: row.nodeId,
          seq: row.seq,
        })),
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
        origin: api.origin(),
        selection: api.selection(),
        sceneSelection: api.sceneSelection(),
        archGraph: api.archGraph(),
        sourceExplorer: api.sourceExplorer(),
        lessons: api.lessons(),
        trace: api.trace(),
        emulatorFacts: wiring.emulatorFacts(),
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
