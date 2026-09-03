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
import { pixelOrigin } from './oled/pixel-provenance.js';
import { ARCH_NODES, HAND_AUTHORED, UPSTREAM_COMMIT } from './generated/architecture-graph.js';
import { ANNOTATIONS_UPSTREAM_COMMIT, CURRICULUM } from './generated/source-annotations.js';
import { archNodesInSymbol, citationsForSymbol, SYMBOL_BY_ID } from './source/model.js';
import { LESSONS, POLISHED_LESSON_IDS } from './generated/lessons.js';
import { IMPLEMENTED_CHECKS, IMPLEMENTED_CONTROLS, UNIMPLEMENTED_CONTROLS } from './lessons/registry.js';
import type { LessonRuntime } from './lessons/runtime.js';
import type { SelectionState } from './state/selection.js';
import { fetchResourceReport, type ResourceReport } from './desktop/resource-report.js';
import type { Breakpoint, DockId, ModuleId, SectionId, StageRule } from './ui/shell-state.js';
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
  /**
   * Which of the three representations is MOUNTED — Phase 4 W4.
   *
   * Read off the DOM rather than recomputed, because the claim under test is
   * "the 63-node graph is not in this pane", and a `mode` derived a second time
   * from a width the harness also measured could only ever agree with itself.
   */
  readonly mode: string | null;
  /** The surface's own inline size, the number `archModeForWidth()` branched on. */
  readonly surfaceWidthPx: number | null;
  /**
   * Node ids with a laid-out box on screen, in DOM order.
   *
   * `visibleNodeIds` is what the FULL graph's layout function would draw;
   * this is what a reader can actually click, in whatever representation is
   * mounted. In `path` mode the two are deliberately different, and an
   * assertion that cannot tell them apart is an assertion this change would
   * have made hollow.
   */
  readonly renderedNodeIds: readonly string[];
  /** The subsystem the intermediate representation is scoped to, if any. */
  readonly subsystem: string | null;
  /** React Flow's applied zoom, or `null` when no canvas is mounted. */
  readonly viewportZoom: number | null;
  /** True while the focus workspace is giving this pane the content area. */
  readonly workspaceOpen: boolean;
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

/**
 * Lab mode, read off the DOM.
 *
 * DOM and not React state, for the same reason `lessons()` is: the claim under
 * test is that the *rendered* page says these things. Every field here is
 * either a `data-*` attribute the Lab renders or the literal contents of an
 * export box, so a harness assertion compares what a person would see against
 * an artefact it recomputes for itself — never against the Lab's own opinion of
 * what it is showing.
 *
 * `exportedCppRoundTripOk` is the sharpest of them: the Lab decides that value
 * by parsing its own output, and the harness does NOT trust it — it parses the
 * `exportedCpp` text independently and compares the pose sequence itself.
 */
export interface LabReading {
  readonly present: boolean;
  readonly open: boolean;
  readonly tab: string | null;
  /** `constrain(angle + subtrim, 0, 180)` per channel, as the table shows it. */
  readonly poseAdjustedDeg: Readonly<Record<string, number | null>>;
  readonly poseTicks: Readonly<Record<string, number | null>>;
  /** The "robot reports" column — the telemetry store's commanded angle. */
  readonly poseReported: Readonly<Record<string, string | null>>;
  readonly frameRows: number;
  readonly exportedCpp: string;
  readonly exportedCppRoundTripOk: boolean | null;
  readonly exportedCppWrites: number | null;
  readonly exportedFace: string;
  readonly exportedFaceRoundTripOk: boolean | null;
  readonly routeOptions: readonly string[];
  readonly httpLog: readonly string[];
  /** The "Sesame Lab is modifying this robot" banner, or `null` when absent. */
  readonly modifications: {
    readonly trims: number;
    readonly faults: number;
    readonly panelAuthored: boolean;
  } | null;
  readonly savedText: string | null;
  readonly storageBlocked: boolean | null;
  /** Bytes under `sesame-lab.lab.v1`, or `null` if storage is unreadable. */
  readonly storedBytes: number | null;
  /** Route count in the generated architecture graph, for the harness to compare. */
  readonly firmwareRouteCount: number;
  readonly honestyNote: string | null;
}

/**
 * The responsive shell, measured rather than asserted.
 *
 * This exists because of the gap that let a 13%-of-screen robot ship: the
 * harness had 26 captures and **not one of them asked how much space the
 * viewport got**. Every number here is read off the live DOM with
 * `getBoundingClientRect` — the CANVAS, not the container that holds it, since
 * a container can be tall while the drawing buffer is not, and that would be
 * exactly the sort of green-but-wrong the old harness produced.
 *
 * `DockReading` is GONE — Phase 4 W7. It described two resizable docks with
 * stored widths and a nested-scroller depth; there are no docks, no stored
 * widths and one scroller. A reading whose subject has been deleted is the same
 * hazard as an assertion whose subject has been deleted: it keeps producing
 * numbers nobody can act on. What replaced it is {@link ModuleColumnReading}
 * and {@link PanelReading}.
 */

/**
 * The module column — Phase 4 W7.
 *
 * One module at a time, or none. `active` is `null` when the robot has the
 * whole content area, and the column then has no laid-out box at all; the
 * panes inside it stay MOUNTED (see `ui/Shell.tsx` for the four invariants
 * that depend on that) and simply have no boxes.
 */
export interface ModuleColumnReading {
  readonly active: ModuleId | null;
  /** The column's measured footprint. 0 with no module active. */
  readonly rectWidthPx: number;
  /** The architecture artifact's own box, when the architecture module is up. */
  readonly surfaceWidthPx: number | null;
  /** Every scrollable box in the column, outermost first. Must be <= 1. */
  readonly scrollers: readonly string[];
  /** Which panes inside the column have a laid-out box. Must be 0 or 1. */
  readonly laidOutPanes: readonly SectionId[];
}

/**
 * The side panel — Phase 4 W7, and the reading §11.4's hardest rule is made of.
 *
 * > *"Never its own scrollbar — neither Commands nor Face. If content does not
 * > fit, that is a content problem to solve by disclosure, not by adding a
 * > scroller."*
 *
 * {@link scrollers} is the direct form of that. {@link overflowPx} is the other
 * half and it is the half that makes the assertion honest: the panel is
 * `overflow: hidden`, so a card that did not fit would be CUT rather than
 * scrolled, and a scroller count alone would go on reading zero while a
 * provenance badge sat below the fold. Both are asserted at every width.
 */
export interface PanelReading {
  readonly visible: boolean;
  readonly rectWidthPx: number;
  readonly rectHeightPx: number;
  /**
   * Every scrollable box inside the panel, outermost first.
   *
   * It used to have to be EMPTY. Phase 4 W5 narrows that on the user's own
   * instruction: two cards are allowed to scroll when their own content does
   * not fit, and nothing else is. {@link PanelReading.illegalScrollers} is the
   * one that must be empty, and it is what the harness asserts.
   */
  readonly scrollers: readonly string[];
  /**
   * Scrollers on the panel that are NOT inside a card that declares itself
   * scrollable — `[data-scrollable="true"]`, which is Commands and Selected
   * joint. **This is the rule that replaced "zero scrollers".**
   */
  readonly illegalScrollers: readonly string[];
  /**
   * Per scrollable card: does its body actually scroll, and by how much.
   *
   * *"Use scrollbars in command and selected joint only if there isn't enough
   * space to show all content"* is a conditional, so the reading has to carry
   * both halves — a card that scrolls with room to spare is as wrong as one
   * that clips.
   */
  readonly scrollableCards: readonly {
    readonly id: string;
    readonly contentPx: number;
    readonly boxPx: number;
    readonly scrolls: boolean;
  }[];
  /** `scrollHeight - clientHeight` on the panel. Must be <= 1. */
  readonly overflowPx: number;
  /** The cards on it, and whether each has a box a reader can see. */
  /**
   * Every card on the panel, in DOM order.
   *
   * The ORDER is asserted from Phase 4 W8 onward: *"the face should be at the
   * very top"*, so `cards[0].id` is `face` and the trust card follows it. It is
   * read out of the DOM rather than from the spec array because the claim is
   * about what a reader meets first.
   */
  readonly cards: readonly {
    readonly id: string;
    readonly visible: boolean;
    readonly heightPx: number;
    /**
     * Was: whether the panel had folded this card away.
     *
     * Nothing folds any more — Phase 4 W5 replaced the fold with a flex rule —
     * and rather than leave a field reporting a constant `false` about a
     * mechanism that no longer exists, it says what the card is now allowed to
     * do with the panel's height.
     */
    readonly scrollable: boolean;
    /** The card that takes the panel's spare height — `ELASTIC_CARD`. */
    readonly elastic: boolean;
  }[];
  /**
   * The correctness surfaces that must be ON the panel rather than only behind
   * a "more info" screen — §11.4.
   *
   * Read by selector, with the popovers closed, so the assertion is about what
   * a reader sees without opening anything. `insidePopover` is `true` when the
   * element found was inside a `<dialog>`, which is the failure this exists to
   * catch: a correctness surface that moved into the screen that was only ever
   * meant to expand it.
   */
  readonly correctness: readonly {
    readonly what: string;
    readonly present: boolean;
    readonly visible: boolean;
    readonly insidePopover: boolean;
    readonly text: string;
  }[];
}

/** One "more info" screen. A closed `<dialog>` has no boxes at all. */
export interface PopoverReading {
  readonly id: string;
  readonly open: boolean;
  readonly scrollers: readonly string[];
}

export interface ShellReading {
  readonly breakpoint: Breakpoint;
  readonly windowWidthPx: number;
  readonly windowHeightPx: number;
  /**
   * True only at Compact, where the workbench is a sheet over the stage.
   *
   * It used to be true below Wide, because U6 floated both docks so the stage
   * never lost a pixel. §3 of the Phase 4 plan replaced that with the user's
   * 50%-area rule and the workbench went back into flow, so at Medium the stage
   * really does shrink — which is what {@link stageAreaSharePct} measures and
   * what replaced the `overlay-not-push` assertion.
   */
  readonly dockOverlays: boolean;
  /** The one active module, or `null` — the robot has the whole content area. */
  readonly activeModule: ModuleId | null;
  /** `Control | Analyze`, DERIVED from {@link activeModule}. Never stored. */
  readonly mode: DockId;
  readonly moduleColumn: ModuleColumnReading;
  readonly panel: PanelReading;
  readonly popovers: readonly PopoverReading[];
  readonly stageWidthPx: number;
  readonly stageHeightPx: number;
  /** The status line under the robot. The strip it replaced was 120-176 px. */
  readonly statusBarHeightPx: number;
  /** Which of the status line's optional segments are on screen at this width. */
  readonly statusSegments: readonly string[];
  /**
   * Quick-run buttons on the status line, hit-tested.
   *
   * `reachable` means the button has a box AND is the topmost element at the
   * centre of it. A `hidden` button inside a collapsed dock section, or one
   * covered by an open overlay, is not reachable — which is the difference
   * between this and the "is it in the DOM" check it replaces.
   */
  readonly quickCommands: readonly {
    readonly name: string;
    readonly visible: boolean;
    readonly reachable: boolean;
    readonly enabled: boolean;
  }[];
  /** The WebGL canvas itself, on screen. */
  readonly canvasWidthPx: number;
  readonly canvasHeightPx: number;
  /** `canvasHeightPx / innerHeight`, as a percentage. The plan's floor is 45. */
  readonly viewportHeightSharePct: number;
  readonly viewportWidthSharePct: number;
  /**
   * **The metric, from Phase 4 §7.** The 3D canvas's area as a percentage of
   * the window's, and the floor is 50 at Medium and above.
   *
   * It replaces `overlay-not-push`, which measured that opening a dock cost the
   * stage 0.0 px. That assertion was true and is now false BY DESIGN: the user
   * said *"I'd rather the robot area shrink. 50% of the screen area is more
   * than enough"*, so what has to be checked is how much is left rather than
   * whether anything moved. Left in place it would have gone on passing against
   * a layout that no longer overlays.
   *
   * Area rather than height, because height was the half of the problem that
   * was already fixed: a full-bleed stage behind an overlay reads ~96% tall and
   * ~100% wide while the robot sits behind a panel, and that is precisely the
   * measurement §7 says stopped meaning anything.
   */
  readonly stageAreaSharePct: number;
  /**
   * The CONTENT box — the viewport minus the rail, the status strip and the
   * side panel — and the stage's share of it.
   *
   * §11.2 resolved the rule conflict into two regimes rather than one loose
   * threshold, and this is the second one's measurement: with a module active
   * the stage keeps >= 50% of THIS box, which is the plain reading of *"with
   * the robot in the other half"*. Measured off the `.content` element's own
   * rect rather than recomputed from `innerWidth`, so a rail or a panel that
   * quietly changed width would move the number rather than being averaged out
   * of it.
   */
  readonly contentWidthPx: number;
  readonly contentHeightPx: number;
  readonly stageContentSharePct: number;
  /**
   * The focus workspace, and WHICH RULE the shell says applies to the stage.
   *
   * Phase 4 W4. Both are read off `.shell`'s own attributes rather than
   * recomputed here, and that is the whole point: the app declares the rule, so
   * a harness can assert the declaration against the measured layout. A check
   * that branched on the same condition the layout branches on could never
   * disagree with it, which is how the three hollow assertions this project has
   * already hit came about.
   *
   *   `area-50`      W3 / plan section 7 - the stage keeps >= 50% of the area.
   *   `focus-exempt` the brief's sanctioned exception, claimable only while the
   *                  pane named by `focusPane` is on screen.
   */
  readonly focusPane: string | null;
  readonly stageRule: StageRule | null;
  readonly openSections: readonly SectionId[];
  /**
   * One entry per section, in draw order: which dock draws it, what its header
   * says while it is collapsed, and whether that badge is about the current
   * selection (§5.1).
   */
  readonly sections: readonly {
    readonly id: SectionId;
    readonly dock: DockId;
    readonly open: boolean;
    /** Expanded AND its dock showing — what a reader can actually see. */
    readonly visible: boolean;
    readonly badge: string | null;
    readonly badgeIsSelection: boolean;
    /** The header's rendered text, which is what a reader actually sees. */
    readonly headerText: string;
  }[];
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
    /**
     * What the pane CLAIMS about where the pixels came from — Phase 4 W8.
     *
     * Derived from the backend's own `oledFramebuffer` / `elided` capability
     * document by `oled/pixel-provenance.ts`, never from which backend is
     * selected. It is published here so the harness can assert that a QEMU
     * image WITHOUT the framebuffer hook says `elided`, and that one WITH it
     * says `observed`, without either assertion naming a backend.
     */
    pixels: { state: string; claim: string; fromEmulator: boolean; paragraphs: number };
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
  /** Lab mode, read off the DOM. */
  lab(): LabReading;
  /** The trace on screen, in causal order. `null` before any command. */
  trace(): TraceReading | null;
  assetFacts(): AssetFacts | null;
  /** Frames drawn and pose version applied — proof the render loop is alive. */
  renderStats(): { frames: number; appliedPoseVersion: number; storePoseVersion: number } | null;
  /** The responsive shell, measured off the DOM. */
  shell(): ShellReading;
  /**
   * Make one module active, or none — as clicking the rail would.
   *
   * The one verb the module-first shell has. {@link setSection} and
   * {@link setDockOpen} are kept as shims over it because eight harness phases
   * are written against the accordion's verbs; they reduce to this call.
   */
  setModule(id: ModuleId | null): void;
  /** Open or close one pane. A module activates; a panel card is always on. */
  setSection(id: SectionId, open: boolean): void;
  /** `analysis` shows the architecture module; `control` clears it. */
  setDockOpen(dock: DockId, open: boolean): void;
  /**
   * What the Tauri desktop shell bundled, and where `app.path()` resolved it —
   * Phase 5 T2. `null` in a browser, which has no bundled resources.
   *
   * Async and therefore NOT part of {@link snapshot}, which is a single
   * synchronous round trip by design. It is the machine-readable half of the
   * same document `[data-testid="desktop-resources"]` renders, and it is what
   * T3 and T6 check the packaged artefact against rather than trusting it.
   */
  resourceReport(): Promise<ResourceReport | null>;
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
  /** The shell controller, for the layout accessors above. */
  shellBreakpoint(): Breakpoint;
  shellActiveModule(): ModuleId | null;
  shellPanelVisible(): boolean;
  shellSheets(): boolean;
  shellMode(): DockId;
  setModule(id: ModuleId | null): void;
  setSection(id: SectionId, open: boolean): void;
  setDockOpen(dock: DockId, open: boolean): void;
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
    resourceReport: () => fetchResourceReport(),

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
        pixels: (() => {
          const origin = pixelOrigin(wiring.emulatorFacts(), store.oledSource);
          return {
            state: origin.state,
            claim: origin.claim,
            fromEmulator: origin.fromEmulator,
            paragraphs: origin.paragraphs.length,
          };
        })(),
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
      const surface = document.querySelector('[data-testid="arch-surface"]');
      const widthAttr = surface?.getAttribute('data-pane-width-px') ?? '';
      const rendered = [...document.querySelectorAll('[data-arch-node]')]
        .map((n) => n.getAttribute('data-arch-node'))
        .filter((id): id is string => id !== null);
      const picked = document.querySelector('[data-arch-subsystem][aria-selected="true"]');
      return {
        upstreamCommit: UPSTREAM_COMMIT,
        totalNodes: ARCH_NODES.length,
        visibleNodeIds: layout.nodes.map((n) => n.node.id),
        expanded: [...expandedIds],
        edges: layout.edges.map((e) => ({ source: e.source, target: e.target, lifted: e.lifted })),
        selectedNodeId: wiring.selection().nodeId,
        handAuthored: [...HAND_AUTHORED],
        unresolvedNodeIds: ARCH_NODES.filter((n) => n.unresolved !== null).map((n) => n.id),
        mode: surface?.getAttribute('data-arch-mode') ?? null,
        surfaceWidthPx: widthAttr === '' ? null : Number(widthAttr),
        renderedNodeIds: rendered,
        subsystem: picked?.getAttribute('data-arch-subsystem') ?? null,
        /*
          The viewport's zoom, read off the transform React Flow actually
          applied — Phase 4 W7.
         
          The subsystem view's whole claim is that at zoom 1 the AUTHORED size
          is the size on screen, so the 14 px floor holds with no exemption. W7
          caught it drawn at 0.929 after a remount, which is a claim quietly
          traded away, so the number is published and asserted rather than
          inferred from how big some text happened to measure.
        */
        viewportZoom: (() => {
          const viewport = document.querySelector('.react-flow__viewport');
          if (viewport === null) return null;
          const transform = getComputedStyle(viewport).transform;
          if (transform === 'none') return 1;
          const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
          const scale = transform.startsWith('matrix3d') ? values[0] : values[0];
          return typeof scale === 'number' && Number.isFinite(scale) ? scale : null;
        })(),
        workspaceOpen:
          document
            .querySelector('[data-testid="arch-workspace-toggle"]')
            ?.getAttribute('aria-pressed') === 'true',
      };
    },

    lab(): LabReading {
      const panel = document.querySelector('[data-testid="lab-panel"]');
      const q = (selector: string): Element | null => panel?.querySelector(selector) ?? null;
      const attr = (selector: string, name: string): string | null =>
        q(selector)?.getAttribute(name) ?? null;
      const textOf = (selector: string): string | null => q(selector)?.textContent?.trim() ?? null;
      const valueOf = (selector: string): string =>
        (q(selector) as HTMLTextAreaElement | null)?.value ?? '';
      const numAttr = (selector: string, name: string): number | null => {
        const raw = attr(selector, name);
        if (raw === null) return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };

      const adjusted: Record<string, number | null> = {};
      const ticks: Record<string, number | null> = {};
      const reported: Record<string, string | null> = {};
      for (const joint of JOINT_ORDER) {
        adjusted[joint] = numAttr(`[data-testid="pose-row-${joint}"]`, 'data-adjusted');
        ticks[joint] = numAttr(`[data-testid="pose-row-${joint}"]`, 'data-ticks');
        reported[joint] = textOf(`[data-testid="pose-reported-${joint}"]`);
      }

      const banner = q('[data-testid="lab-modifications"]');
      let storedBytes: number | null = null;
      try {
        storedBytes = globalThis.localStorage?.getItem('sesame-lab.lab.v1')?.length ?? 0;
      } catch {
        storedBytes = null;
      }

      const roundTripFlag = attr('[data-testid="lab-cpp-roundtrip"]', 'data-ok');
      const faceFlag = attr('[data-testid="lab-face-roundtrip"]', 'data-ok');
      const blocked = attr('[data-testid="lab-saved"]', 'data-blocked');

      return {
        present: panel !== null,
        open: panel?.getAttribute('data-open') === 'true',
        tab: panel?.getAttribute('data-tab') ?? null,
        poseAdjustedDeg: adjusted,
        poseTicks: ticks,
        poseReported: reported,
        frameRows: panel === null ? 0 : panel.querySelectorAll('[data-testid^="sequence-frame-"]').length,
        exportedCpp: valueOf('[data-testid="lab-cpp-source"]'),
        exportedCppRoundTripOk: roundTripFlag === null ? null : roundTripFlag === 'true',
        exportedCppWrites: numAttr('[data-testid="lab-cpp-roundtrip"]', 'data-writes'),
        exportedFace: valueOf('[data-testid="lab-face-source"]'),
        exportedFaceRoundTripOk: faceFlag === null ? null : faceFlag === 'true',
        routeOptions:
          panel === null
            ? []
            : [...panel.querySelectorAll('[data-testid="http-route"] option')].map(
                (node) => (node as HTMLOptionElement).value,
              ),
        httpLog:
          panel === null
            ? []
            : [...panel.querySelectorAll('[data-testid="http-log"] li')].map(
                (node) => node.textContent?.trim() ?? '',
              ),
        modifications:
          banner === null
            ? null
            : {
                trims: Number(banner.getAttribute('data-trims') ?? '0'),
                faults: Number(banner.getAttribute('data-faults') ?? '0'),
                panelAuthored: banner.getAttribute('data-panel-authored') === 'true',
              },
        savedText: textOf('[data-testid="lab-saved"]'),
        storageBlocked: blocked === null ? null : blocked === 'true',
        storedBytes,
        firmwareRouteCount: ARCH_NODES.filter((n) => n.kind === 'route').length,
        honestyNote: textOf('[data-testid="lab-honesty"]'),
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

    shell(): ShellReading {
      const rectOf = (selector: string): { width: number; height: number } => {
        const el = document.querySelector(selector);
        if (el === null) return { width: 0, height: 0 };
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      };
      const stage = rectOf('[data-testid="stage"]');
      const statusBar = rectOf('[data-testid="stage-status"]');
      const content = rectOf('[data-testid="content"]');
      // The renderer's canvas is found by asking each `<canvas>` for a WebGL
      // context, exactly as `canvasPixelCount()` does: the OLED panel's canvas
      // is a 2D one and answers `null`, so there is no dependence on a class
      // name R3F may or may not forward.
      let canvas: HTMLCanvasElement | null = null;
      for (const candidate of document.querySelectorAll('canvas')) {
        if ((candidate.getContext('webgl2') ?? candidate.getContext('webgl')) !== null) {
          canvas = candidate;
          break;
        }
      }
      const canvasRect = canvas?.getBoundingClientRect() ?? null;
      const canvasWidthPx = canvasRect?.width ?? 0;
      const canvasHeightPx = canvasRect?.height ?? 0;
      const w = globalThis.innerWidth;
      const h = globalThis.innerHeight;
      const activeModule = wiring.shellActiveModule();
      const panelVisible = wiring.shellPanelVisible();

      const laidOut = (el: Element | null): boolean => {
        if (el === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      };

      /*
       * §5.1, read from wherever it is actually rendered.
       *
       * A selection that lands in a module the reader is not looking at is
       * announced on that module's RAIL button — the one zone that is always on
       * screen. The badge still carries `data-dock-badge="<id>"`, so this stays
       * one document-wide lookup rather than a second code path, and the claim
       * the harness asserts is measured against the thing on screen.
       */
      const sections = [...document.querySelectorAll('[data-dock-section]')].map((el) => {
        const id = (el.getAttribute('data-dock-section') ?? '') as SectionId;
        const dock = (el.getAttribute('data-dock') ?? 'analysis') as DockId;
        const badge = document.querySelector(`[data-dock-badge="${id}"]`);
        const rail = document.querySelector(`[data-module-nav="${id}"]`);
        const header = rail ?? el.querySelector('.pane__header');
        const open = el.getAttribute('data-open') === 'true';
        return {
          id,
          dock,
          open,
          visible: laidOut(el.querySelector(`[data-pane-content="${id}"]`)),
          badge: badge === null ? null : (badge.textContent ?? '').trim(),
          badgeIsSelection: badge?.getAttribute('data-selection') === 'true',
          headerText: (header?.textContent ?? '').trim(),
        };
      });

      /**
       * How many NESTED scrollable boxes stand between a root and its deepest
       * laid-out content.
       *
       * `overflow-y: auto` on a box whose content fits produces no scrollbar
       * and costs a reader nothing, so an element counts only when it is
       * scrollable right now.
       */
      const scrollersIn = (
        root: Element,
      ): { depth: number; chain: readonly string[]; scrollers: readonly string[] } => {
        const describe = (el: Element): string => {
          const testid = el.getAttribute('data-testid');
          const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c !== '')[0];
          const name =
            testid !== null ? `[${testid}]` : cls === undefined ? el.tagName.toLowerCase() : `.${cls}`;
          /*
            The DECLARED two-dimensional surfaces are marked — Phase 4 W8.

            W2's rule is "a pane owns one ORDINARY vertical scroller; anything
            else that scrolls has to declare itself with `data-2d-surface`", and
            the container sweep has always read the list that way. This reading
            did not mark them because until W8 no declared surface inside the
            module column actually scrolled: the Source code region took its
            content height. Beside the outline it is a bounded 420 px viewport
            again, so the marker has to be here too — and it is a MARKER rather
            than a filter, so a new declared surface still shows up in the list.
          */
          return el.hasAttribute('data-2d-surface') ? `${name}(2d)` : name;
        };
        // A `<textarea>` of exported C++ scrolls because it is a text control,
        // not because the layout nested three boxes; that is a different thing
        // from the problem a reader reported and is excluded on purpose.
        const FORM = new Set(['TEXTAREA', 'INPUT', 'SELECT']);
        const isScroller = (el: Element): boolean => {
          if (FORM.has(el.tagName)) return false;
          if (el.scrollHeight <= el.clientHeight + 1) return false;
          const overflow = getComputedStyle(el).overflowY;
          return overflow === 'auto' || overflow === 'scroll';
        };
        const found: Element[] = [];
        if (isScroller(root)) found.push(root);
        for (const el of root.querySelectorAll('*')) if (isScroller(el)) found.push(el);
        let depth = 0;
        let chain: readonly string[] = [];
        for (const el of found) {
          const here = found.filter((other) => other === el || other.contains(el));
          if (here.length > depth) {
            depth = here.length;
            chain = here.map(describe);
          }
        }
        return { depth, chain, scrollers: found.map(describe) };
      };

      const columnRoot = document.querySelector('[data-testid="module-column"]');
      const surface = document.querySelector('[data-testid="arch-surface"]');
      const moduleColumn: ModuleColumnReading = {
        active: activeModule,
        rectWidthPx: columnRoot?.getBoundingClientRect().width ?? 0,
        surfaceWidthPx: laidOut(surface) ? (surface?.getBoundingClientRect().width ?? null) : null,
        scrollers: columnRoot === null ? [] : scrollersIn(columnRoot).scrollers,
        laidOutPanes: [...document.querySelectorAll('.module-pane [data-pane-content]')]
          .filter((el) => laidOut(el))
          .map((el) => (el.getAttribute('data-pane-content') ?? '') as SectionId),
      };

      /*
       * The side panel's correctness inventory — §11.4.
       *
       * A named list, read with every popover closed, because the rule is about
       * what a reader sees WITHOUT opening anything: *"a popover may expand
       * them; it may not be where they first appear."* `insidePopover` is what
       * catches the failure this list exists for — the element still exists, it
       * is just no longer somewhere anybody will meet it.
       */
      const PANEL_CORRECTNESS: readonly { what: string; selector: string }[] = [
        { what: 'the driving provenance badge', selector: '[data-testid="panel-provenance"] .prov' },
        { what: 'the driving origin, in full', selector: '#origin-banner [data-origin-kind]' },
        { what: 'the measurement verdict', selector: '#measurement-verdict' },
        { what: 'PHYSICAL HARDWARE', selector: '[data-testid="panel-physical-hardware"]' },
        { what: 'the OLED pixel provenance', selector: '[data-panel-card="face"] [data-provenance]' },
        /*
          Read off the card's SUMMARY, which rides on the header whether the
          card is folded or not — so this stays true at a window short enough
          for the panel to fold Commands away, which is exactly the case the
          rule exists for.
        */
        { what: 'the zero-frame faces, marked', selector: '[data-panel-card="face"] [data-zero-frame-faces]' },
        { what: 'the selected joint, summarised', selector: '[data-panel-summary="inspector"]' },
      ];
      const panelRoot = document.querySelector('[data-testid="side-panel"]');
      const panelInner = document.querySelector('[data-testid="side-panel-inner"]');
      const panel: PanelReading = {
        visible: panelVisible && laidOut(panelRoot),
        rectWidthPx: panelRoot?.getBoundingClientRect().width ?? 0,
        rectHeightPx: panelRoot?.getBoundingClientRect().height ?? 0,
        scrollers: panelRoot === null ? [] : scrollersIn(panelRoot).scrollers,
        /*
          The narrowed rule — Phase 4 W5. A scroller is legal exactly when it is
          inside a card that has declared itself scrollable in the markup, which
          is `SCROLLABLE_CARDS` in `ui/Shell.tsx` and nowhere else. Computed
          from the DOM rather than from a list of names here, so adding a third
          scrollable card is a change to one file.
        */
        illegalScrollers:
          panelRoot === null
            ? []
            : [panelRoot, ...panelRoot.querySelectorAll('*')]
                .filter((el) => {
                  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName)) return false;
                  if (el.scrollHeight <= el.clientHeight + 1) return false;
                  const overflow = getComputedStyle(el).overflowY;
                  if (overflow !== 'auto' && overflow !== 'scroll') return false;
                  return el.closest('[data-scrollable="true"]') === null;
                })
                .map((el) => {
                  const testid = el.getAttribute('data-testid');
                  const cls = (el.getAttribute('class') ?? '').split(/\s+/)[0];
                  return testid !== null ? `[${testid}]` : `.${cls ?? el.tagName}`;
                }),
        scrollableCards: [...document.querySelectorAll('[data-scrollable="true"]')].map((card) => {
          const body = card.querySelector('.panel-card-body');
          return {
            id: card.getAttribute('data-panel-card') ?? '',
            contentPx: body === null ? 0 : body.scrollHeight,
            boxPx: body === null ? 0 : body.clientHeight,
            scrolls: body !== null && body.scrollHeight > body.clientHeight + 1,
          };
        }),
        overflowPx:
          panelInner === null
            ? 0
            : Math.max(
                panelInner.scrollHeight - panelInner.clientHeight,
                panelRoot === null ? 0 : panelRoot.scrollHeight - panelRoot.clientHeight,
              ),
        cards: [...document.querySelectorAll('[data-panel-card]')].map((el) => ({
          id: el.getAttribute('data-panel-card') ?? '',
          visible: laidOut(el),
          heightPx: el.getBoundingClientRect().height,
          scrollable: el.getAttribute('data-scrollable') === 'true',
          elastic: el.getAttribute('data-elastic') === 'true',
        })),
        correctness: PANEL_CORRECTNESS.map(({ what, selector }) => {
          const el = document.querySelector(selector);
          return {
            what,
            present: el !== null,
            visible: laidOut(el),
            insidePopover: el !== null && el.closest('dialog') !== null,
            text: el === null ? '' : (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
          };
        }),
      };

      const popovers: PopoverReading[] = [...document.querySelectorAll('[data-popover]')].map((el) => ({
        id: el.getAttribute('data-popover') ?? '',
        open: (el as HTMLDialogElement).open,
        scrollers: scrollersIn(el).scrollers,
      }));

      const shellRoot = document.querySelector('[data-testid="shell"]');

      const statusSegments = [
        ...document.querySelectorAll('[data-testid="stage-status"] [data-testid]'),
      ]
        .map((el) => (el.getAttribute('data-testid') ?? '').replace(/^status-/, ''))
        .filter((name) => name !== '');

      /*
       * Reachability, hit-tested rather than merely present.
       *
       * What matters is whether a reader can press the thing, so the button
       * must have a box AND be the topmost element at the centre of that box —
       * an open sheet or a scrim covering it counts as not reachable.
       */
      const quickCommands = [...document.querySelectorAll('[data-quick-command]')].map((el) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const hit = visible
          ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : null;
        return {
          name: el.getAttribute('data-quick-command') ?? '',
          visible,
          reachable: hit !== null && (hit === el || el.contains(hit)),
          enabled: !(el as HTMLButtonElement).disabled,
        };
      });

      const contentWidthPx = content.width;
      const contentHeightPx = content.height;

      return {
        breakpoint: wiring.shellBreakpoint(),
        windowWidthPx: w,
        windowHeightPx: h,
        dockOverlays: wiring.shellSheets(),
        activeModule,
        mode: wiring.shellMode(),
        moduleColumn,
        panel,
        popovers,
        stageWidthPx: stage.width,
        stageHeightPx: stage.height,
        statusBarHeightPx: statusBar.height,
        statusSegments,
        quickCommands,
        canvasWidthPx,
        canvasHeightPx,
        viewportHeightSharePct: h === 0 ? 0 : (canvasHeightPx / h) * 100,
        viewportWidthSharePct: w === 0 ? 0 : (canvasWidthPx / w) * 100,
        stageAreaSharePct: w === 0 || h === 0 ? 0 : ((canvasWidthPx * canvasHeightPx) / (w * h)) * 100,
        contentWidthPx,
        contentHeightPx,
        stageContentSharePct:
          contentWidthPx === 0 || contentHeightPx === 0
            ? 0
            : ((canvasWidthPx * canvasHeightPx) / (contentWidthPx * contentHeightPx)) * 100,
        focusPane: shellRoot?.getAttribute('data-focus-pane') || null,
        stageRule: (shellRoot?.getAttribute('data-stage-rule') as StageRule | null) ?? null,
        openSections: sections.filter((s) => s.visible).map((s) => s.id),
        sections,
      };
    },

    setModule: (id) => wiring.setModule(id),
    setSection: (id, open) => wiring.setSection(id, open),
    setDockOpen: (dock, open) => wiring.setDockOpen(dock, open),

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
        lab: api.lab(),
        trace: api.trace(),
        emulatorFacts: wiring.emulatorFacts(),
        face: wiring.store.face,
        shell: api.shell(),
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
