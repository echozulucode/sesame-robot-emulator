/**
 * V3 + V4 (the browser robot) and V8 (the architecture graph + "See the Signal").
 *
 * Layout is the responsive shell: a 56 px rail that never collapses, a stage
 * that gets every pixel nothing else claimed, a thin status line under it, and
 * TWO docks of accordion sections.
 *
 * ```text
 * +--+---------------------------+-------------+---------------+
 * |  |                           | CONTROL     | ANALYSIS      |
 * |R |        CENTER STAGE       | v Commands  | v Inspector   |
 * |A |     3D robot (>= 45vh)    | > Face      | > Modules     |
 * |I |                           | > Lab       | > Signal      |
 * |L +---------------------------+             | > Source      |
 * |  |  status line (~34 px)     |             | > Learn       |
 * +--+---------------------------+-------------+---------------+
 *  56px       never < 45vh          0/44/360      0/44/460
 * ```
 *
 * The control dock is INBOARD, so the reading order is the robot, then the
 * surfaces that drive it, then the surfaces that explain it. It holds the
 * command vocabulary and the 128x64 face, which used to be a fixed
 * `clamp(120px, 20vh, 176px)` strip under the stage — up to 176 px taken from
 * the one thing this shell exists to maximise. The status line took its place
 * at 34 px, and the commands worth one click are on it as a `data-quick-command`
 * cluster, so `wave` is still reachable at every breakpoint without opening
 * anything.
 *
 * It replaced a `minmax(0,1fr) minmax(0,520px) 400px` grid with a fixed 380 px
 * source row, which on a 1440x900 laptop left the 3D viewport about 500x280 —
 * 13% of the screen, on the machine the product was being evaluated on. The
 * rule that fixes that case is in `ui/shell.ts` and `styles.css`: **below 1441
 * px the dock overlays the stage instead of pushing it**, so opening a pane
 * costs the robot nothing. `capture-web-screenshots.mjs` phase 12 measures the
 * canvas at four window sizes and asserts the share, which is the assertion
 * whose absence let the old layout ship.
 *
 * Data flow, once:
 *
 * ```text
 * backend (sim in-process | bridge WebSocket | QEMU over the lab host)
 *    -> SesameTelemetry
 *    -> TelemetryStore.ingest()      one reduction, provenance preserved
 *    -> TraceStore.ingest()          the same events, arranged causally
 *    -> useFrame reads store.poseVersion -> Object3D.quaternion   (60 Hz, no React)
 *    -> useStoreTick re-renders the panels                        (~8 Hz)
 * ```
 *
 * ## One selection, four panes
 *
 * The report is explicit that cross-pane highlighting is worth more than
 * decorative gamification, so there is exactly one `SelectionState` here and
 * the 3D scene, the graph, the trace and the joint inspector all read and write
 * it. Selecting `R4` anywhere selects it everywhere, and the graph auto-expands
 * whatever chain is needed to put `joint.R4` on screen. Nothing keeps a private
 * copy of "what is selected"; the previous `selected: JointName | null` is now
 * a derived value. L4 adds the source pane on the same terms: it calls
 * `selectSymbol()` and reads `selection.symbolId`, and owns no selection of its
 * own.
 */
import { JOINT_ORDER, quantiseCommandedAngle, type JointName } from '@sesame-lab/sesame-model';
import { COMMAND_VOCABULARY, OLED_HEIGHT, OLED_WIDTH } from '@sesame-lab/sesame-protocol';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { BridgeBackend, sameOriginBridgeUrl } from './backends/bridge-backend.js';
import {
  DEFAULT_BACKEND,
  desktopSimulatorProbe,
  detectDesktopShell,
  initialBackend,
  probeLabHost,
  type LabHostProbe,
} from './backends/default-backend.js';
import { defaultLabBaseUrl, QemuBackend } from './backends/qemu-backend.js';
import { SimBackend } from './backends/sim-backend.js';
import { TauriBackend } from './backends/tauri/backend.js';
import type { BackendId, BackendStatus, TelemetryBackend } from './backends/types.js';
import { installDebugHook } from './debug-hook.js';
import { renderAuthoredBitmap } from './oled/framebuffer.js';
import { pixelOrigin } from './oled/pixel-provenance.js';
import { symbolAt, symbolContains, SYMBOL_BY_ID } from './source/model.js';
import { expansionsFor } from './arch/layout.js';
import { flattenWrites, outOfRangeAngles, type SequenceDoc } from './editors/sequence.js';
import { BOOT_ORDER } from './generated/lessons.js';
import { SERVO_PINS_BY_BOARD } from './generated/architecture-graph.js';
import type { ModelReading } from './lessons/checks.js';
import { LessonRuntime, runBootModel } from './lessons/runtime.js';
import type { LessonWiring } from './lessons/wiring.js';
import { LabMode } from './lab/LabMode.js';
import type { LabWiring } from './lab/lab-wiring.js';
import { LessonRunner } from './ui/LessonRunner.js';
import {
  EMPTY_SELECTION,
  litJointsFor,
  selectJoint,
  selectNode,
  selectSymbol,
  type SelectionState,
} from './state/selection.js';
import { TelemetryStore } from './state/telemetry-store.js';
import { TraceStore, type TraceRow } from './state/trace-store.js';
import { RobotScene, type SceneHandles } from './three/RobotScene.js';
import { commandedDegFromNode, type AssetFacts, type JointRig } from './three/rig.js';
import { ArchitectureGraph } from './ui/ArchitectureGraph.js';
import { AssetPanel } from './ui/AssetPanel.js';
import { BackendPanel, CommandBar, FaceBar } from './ui/Controls.js';
import { EmulatorPanel } from './ui/EmulatorPanel.js';
import { JointInspector } from './ui/JointInspector.js';
import { OledPanel } from './ui/OledPanel.js';
import { SignalTrace } from './ui/SignalTrace.js';
import { SourceExplorer } from './ui/SourceExplorer.js';
import {
  ModuleColumn,
  Popover,
  Rail,
  SidePanel,
  useShell,
  type ModuleSpec,
  type PanelCardSpec,
} from './ui/Shell.js';
import { StatusBar } from './ui/StatusBar.js';
import {
  moduleForSelection,
  MODULE_LABEL,
  stageRuleFor,
  type ModuleId,
} from './ui/shell-state.js';
import { InfoDot } from './ui/InfoDot.js';
import { JointGlance } from './ui/JointInspector.js';
import { ProvenanceTag } from './ui/ProvenanceTag.js';
import { TrustCard } from './ui/Controls.js';
import { lessonProgress, loadProgress } from './lessons/progress.js';
import { LESSON_BY_ID, LESSONS } from './generated/lessons.js';

/**
 * Re-render the panels at a fixed low rate instead of per event.
 *
 * A `runWavePose` produces a servo event every 20 ms plus face frames; letting
 * each one re-render the inspector would burn frames the 3D view needs and
 * would make no visible difference at 8 Hz.
 */
function useStoreTick(store: { readonly version: number }, intervalMs = 120): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let seen = -1;
    const id = setInterval(() => {
      if (store.version === seen) return;
      seen = store.version;
      setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [store, intervalMs]);
  return tick;
}

/** The nine nodes the report's collapsed tree draws. Nothing expanded. */
const NO_EXPANSIONS: ReadonlySet<string> = new Set();

/** A stable empty array, so the source pane does not re-render on identity. */
const EMPTY_ROWS: readonly TraceRow[] = [];

export function App(): ReactElement {
  const store = useMemo(() => new TelemetryStore(), []);
  const traceStore = useMemo(() => new TraceStore(), []);
  /**
   * Learn mode's memory. Third consumer of the same event stream, on the same
   * terms as the other two: it is handed every event `onEvent` sees, and it
   * reconstructs nothing.
   */
  const lessonRuntime = useMemo(() => new LessonRuntime(), []);
  const modelReading = useRef<ModelReading | null>(null);

  /** The 128x64 canvas that becomes the `CanvasTexture` on `oled_screen`. */
  const oledCanvas = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = OLED_WIDTH;
    canvas.height = OLED_HEIGHT;
    return canvas;
  }, []);
  const oledDirty = useRef(0);

  /*
   * QEMU is the default — Phase 4 W8, and the user's own sentence.
   *
   * > *"The QEMU should be the default."*
   *
   * The initial value is the constant so the first paint is already on the
   * emulator: `just dev` and `just run` both put a QEMU lab host on this
   * origin, and a frame of "Simulated model" before switching would be the
   * app claiming a host model drove something it did not. The probe below then
   * corrects it to `sim` where the lab host says it is running the simulator —
   * see `backends/default-backend.ts` for why the no-host case does NOT fall
   * back to `sim`.
   *
   * **Phase 5 T1 adds one more arrangement, and does not touch the rule above.**
   * Inside the Tauri desktop shell there is no origin to probe and no lab host
   * to start, so the app opens on the behavioural simulator *and announces it*
   * — `initialBackend` decides that synchronously, on the first paint, for the
   * same reason W8 wanted the constant there: the frame before a correction is
   * a claim, and this one would be the wrong claim in the other direction.
   * When T4 lands `TauriSesameRobot` the constant behind `detectDesktopShell`
   * changes and this line follows it with no edit here.
   */
  const desktop = useMemo(() => detectDesktopShell(), []);
  const [backendId, setBackendId] = useState<BackendId>(() => initialBackend(desktop));
  /** What `/lab/session` said, or `null` until it has answered. */
  const [labProbe, setLabProbe] = useState<LabHostProbe | null>(() =>
    desktop.selectsSimulator ? desktopSimulatorProbe() : null,
  );
  const backendPicked = useRef(false);
  const [bridgeUrl, setBridgeUrl] = useState(sameOriginBridgeUrl());
  const [labUrl, setLabUrl] = useState(defaultLabBaseUrl());
  const [status, setStatus] = useState<BackendStatus>({
    connection: 'idle',
    detail: 'starting',
    eventsReceived: 0,
  });
  const backendRef = useRef<TelemetryBackend | null>(null);
  const [backend, setBackend] = useState<TelemetryBackend | null>(null);

  /**
   * The responsive shell: breakpoint, open dock sections, dock width.
   *
   * Declared here rather than inside `<Dock>` because two things outside the
   * dock read it — the rail's mode buttons, and the selection path below, which
   * has to be able to put a highlighted pane back on screen.
   */
  const shell = useShell();

  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_EXPANSIONS);
  const [shownTraceId, setShownTraceId] = useState<string | null>(null);
  const [showTopCover, setShowTopCover] = useState(true);
  const [driveFromSimulated, setDriveFromSimulated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The FOCUS WORKSPACE — Phase 4 W4.
   *
   * > *"The focus workspace should be an explicit action such as 'Open
   * > architecture workspace'. It can temporarily give the graph most of the
   * > content area while retaining Sesame as a live, smaller stage. This is the
   * > one place where I would interpret 'robot must remain dominant' as product
   * > identity and persistent causal feedback, not literally 'the robot must
   * > own more pixels than every task surface at every instant'."*
   *
   * It is a section id rather than a boolean because it is the sanctioned
   * exception to W3's stage-area rule, and an exception that names WHICH pane
   * it is for can be asserted; a bare `focus: true` cannot. `.shell` publishes
   * it as `data-focus-pane`, and `data-stage-rule` alongside it says which of
   * the two rules is in force — see the shell element below.
   */
  const [focusPane, setFocusPane] = useState<ModuleId | null>(null);
  /** Which "more info" screen is open, if any. At most one — it is a modal. */
  const [popover, setPopover] = useState<
    'trust' | 'commands' | 'face' | 'inspector' | 'oled-pixels' | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const handles = useRef<SceneHandles | null>(null);
  const [rig, setRig] = useState<Record<JointName, JointRig> | null>(null);
  const [facts, setFacts] = useState<AssetFacts | null>(null);
  const [groundPlaneMm, setGroundPlaneMm] = useState<number | null>(null);

  const tick = useStoreTick(store);
  // Slower than the telemetry panel's 120 ms: the trace panel renders ~40 rows
  // of prose, and under SwiftShader those repaints come straight out of the 3D
  // view's frame budget.
  const traceTick = useStoreTick(traceStore, 260);
  void tick;
  void traceTick;

  const selected = selection.joint;
  // What the renderer paints. A joint selection lights one; a symbol
  // selection lights every joint that span of code commands.
  const litJoints = useMemo(() => litJointsFor(selection), [selection]);

  // ------------------------------------------------------------- selection
  //
  // Every pane routes through here. `expansionsFor` is additive: selecting a
  // joint in the 3D view opens whatever chain is needed to show `joint.R4`, and
  // never closes something the learner opened on purpose.
  const applySelection = useCallback(
    (next: SelectionState) => {
      setSelection(next);
      const needed = next.nodeId === null ? [] : expansionsFor(next.nodeId);
      if (needed.length > 0) {
        setExpanded((previous) => {
          if (needed.every((id) => previous.has(id))) return previous;
          const union = new Set(previous);
          for (const id of needed) union.add(id);
          return union;
        });
      }
      // §5.2 of the plan, and the reason the whole change is not a regression.
      //
      // Clicking `R4` in the 3D scene highlights it in the graph, the trace and
      // the inspector. Below Wide those sections are collapsed one at a time,
      // so without this the highlight would happen where nobody can see it and
      // the app would appear to do nothing — a genuine regression in the
      // feature Phase 2 spent the most effort on.
      //
      // Restricted to selections that came FROM THE SCENE on purpose. A click
      // inside a pane that is already open needs no help, and a lesson step
      // that selects a symbol must not yank the dock out from under the learner
      // playing it: `LessonRunner` calls `selectSymbol` with origin `source`,
      // and hijacking the accordion there would break Learn at Medium to fix a
      // problem Learn does not have.
      /*
        §5.2 — put the pane that EXPLAINS a scene selection where it can be
        seen. One module is active at a time now, so revealing one puts the
        other away, which is why this still fires only for selections that
        originated in the 3D scene: a click inside a module that is already on
        screen needs no help, and swapping the module out from under a learner
        mid-lesson would be worse than the problem it solves.

        It no longer depends on the breakpoint. W3 guarded it with a
        two-docks-are-both-open predicate, because at Wide the target was
        already on screen; there is one shell now and the target is only ever
        visible if it IS the active module.
      */
      if (next.origin === 'scene') {
        const target = moduleForSelection(next);
        if (target !== null) shell.reveal(target);
      }
    },
    [shell.reveal],
  );

  const selectJointFrom = useCallback(
    (joint: JointName | null, from: 'scene' | 'inspector') => applySelection(selectJoint(joint, from)),
    [applySelection],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectSymbolFrom = useCallback(
    (symbolId: string | null) => applySelection(selectSymbol(symbolId, 'source')),
    [applySelection],
  );

  const selectTraceRow = useCallback(
    (row: TraceRow) => {
      if (row.joint !== null) {
        applySelection(selectJoint(row.joint, 'trace'));
        return;
      }
      if (row.nodeId !== null) {
        applySelection(selectNode(row.nodeId, 'trace'));
        return;
      }
      // `ui.command` and `http.request` carry a `sourceRef` and no node, so
      // without this last arm the two rows a learner clicks first would select
      // nothing at all. The symbol is whatever span that citation lands in.
      const symbol = row.sourceRef === null ? null : symbolAt(row.sourceRef.file, row.sourceRef.line);
      applySelection(symbol === null ? EMPTY_SELECTION : selectSymbol(symbol.id, 'trace'));
    },
    [applySelection],
  );

  /*
   * ------------------------------------------------ what is behind this origin
   *
   * One request, once, on mount. It can only move the app from the QEMU default
   * to `sim`, and only while the reader has not chosen for themselves —
   * `backendPicked` is set by `chooseBackend` below, so a probe that lands after
   * a click cannot undo the click. Everything else it does is record what it
   * found, which is what turns "no lab host" into guidance instead of an
   * unexplained error.
   */
  useEffect(() => {
    // The desktop shell has no origin to probe, and that stayed true when T4
    // gave it an emulator — the emulator is a Rust command, not an HTTP host.
    // Firing the request anyway would 404 against the `tauri://` asset protocol
    // and land on `labHost: 'absent'`, which is the state that renders "start a
    // lab host" — advice a reader of a packaged .exe cannot act on, and which
    // would now also be describing a perfectly good emulator as absent.
    //
    // `desktop.present`, not `desktop.selectsSimulator`: the second one goes
    // false the moment `TAURI_EMULATOR_BACKEND` names a backend, and gating on
    // it would have quietly re-enabled the probe inside the packaged app.
    if (desktop.present) return;
    let disposed = false;
    void probeLabHost(labUrl).then((probe) => {
      if (disposed) return;
      setLabProbe(probe);
      if (backendPicked.current) return;
      setBackendId((previous) => (previous === DEFAULT_BACKEND ? probe.backend : previous));
    });
    return () => {
      disposed = true;
    };
  }, [labUrl, desktop]);

  /** A backend the READER chose. Pins it against the probe landing late. */
  const chooseBackend = useCallback((id: BackendId) => {
    backendPicked.current = true;
    setBackendId(id);
  }, []);

  // ----------------------------------------------------------- backend swap
  useEffect(() => {
    let disposed = false;
    // Every `BackendId` gets an arm. A `switch` over the union rather than a
    // ternary chain, so a fourth backend is a compile error here instead of a
    // silent fall-through to the bridge.
    const build = (): TelemetryBackend => {
      switch (backendId) {
        case 'sim':
          return new SimBackend();
        case 'bridge':
          return new BridgeBackend({ url: bridgeUrl });
        case 'qemu':
          // The same backend id, two owners of the process. In a browser the
          // emulator belongs to `apps/web/server/lab-host.mjs` on this origin
          // and is reached over HTTP + SSE; in the desktop shell it belongs to
          // this app's own Rust supervisor and is reached over IPC. What is
          // behind the wire — real firmware under Espressif's QEMU, commanded
          // through the firmware's own serial console — is identical, which is
          // why this is one arm and not two. See `backends/tauri/backend.ts`.
          return desktop.present ? new TauriBackend() : new QemuBackend({ baseUrl: labUrl });
      }
    };
    const next: TelemetryBackend = build();

    // A backend switch is a different robot, not a continuation of the same
    // one. Keeping the previous joint angles would attribute one backend's
    // state to another's provenance — and keeping the previous trace would be
    // worse, because its rows carry the old backend's origins.
    store.reset();
    traceStore.reset();
    lessonRuntime.resetTelemetry();
    // A different robot: the previous one's face and playback mode must not be
    // left standing as if this backend had reported them.
    modelReading.current = null;
    setShownTraceId(null);
    backendRef.current = next;
    setBackend(next);
    setStatus(next.status);
    setError(null);

    const offEvent = next.onEvent((event) => {
      store.ingest(event);
      traceStore.ingest(event);
      lessonRuntime.noteEvent(event);
    });
    const offStatus = next.onStatus((s) => {
      if (!disposed) setStatus(s);
    });
    void next.start().catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      offEvent();
      offStatus();
      void next.stop();
    };
  }, [backendId, bridgeUrl, labUrl, desktop, store, traceStore, lessonRuntime]);

  // ------------------------------------------------- model-state pump (rAF)
  useEffect(() => {
    let frame = 0;
    const pump = (): void => {
      frame = requestAnimationFrame(pump);
      const current = backendRef.current;
      if (current === null) return;
      // `SimulatedSesameRobot.getState()` is synchronous under the promise, so
      // this costs nothing and never queues behind a running movement.
      void current.modelState().then((state) => {
        if (state === null) return;
        store.applyModelState(state.joints);
        // The lesson runner's window onto `RobotState`. `currentFaceMode` is a
        // GLOBAL the next movement overwrites, so `face-mode-identified` can
        // only be answered from a sample taken WHILE the movement runs — which
        // is why this is sampled rather than read once at the end.
        const reading: ModelReading = {
          faceName: state.face.expression,
          faceFrame: state.face.frame,
          faceMode: state.simulated.faceMode,
          faceFrameCount: state.simulated.faceFrameCount,
          runningMovement: state.simulated.runningMovement,
          currentCommand: state.motion.command ?? '',
          idleActive: state.simulated.idleActive,
        };
        modelReading.current = reading;
        lessonRuntime.noteModelSample({
          runningMovement: reading.runningMovement,
          faceName: reading.faceName,
          faceMode: reading.faceMode,
          faceFrame: reading.faceFrame,
        });
      });
    };
    frame = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(frame);
  }, [store, lessonRuntime]);

  // ------------------------------------------------- lesson symbol history
  //
  // `source-span-selected` sometimes asks HOW a span was reached — from
  // `setServoAngle`, or from a trace row — and the current selection cannot
  // answer that. The visit list can, and it is fed from the one shared
  // selection rather than from anything the lesson pane does itself.
  useEffect(() => {
    if (selection.symbolId !== null) lessonRuntime.noteSymbolVisit(selection.symbolId, selection.origin);
  }, [selection, lessonRuntime]);

  // ---------------------------------------------------------- ground plane
  useEffect(() => {
    const id = setInterval(() => {
      const mm = handles.current?.groundPlaneMm() ?? null;
      setGroundPlaneMm((previous) => (previous === mm ? previous : mm));
    }, 250);
    return () => clearInterval(id);
  }, []);

  // -------------------------------------------------- visual.joint sampling
  //
  // The trace's last rung is what the SCENE is showing, so it has to be read
  // off `Object3D.quaternion` rather than off the store. Sampling on an
  // interval instead of inside `useFrame` keeps the render loop free of React
  // and matches the rate the panels repaint at anyway.
  useEffect(() => {
    const id = setInterval(() => {
      const currentRig = handles.current?.rig;
      if (currentRig === undefined) return;
      for (const joint of JOINT_ORDER) {
        traceStore.noteVisual(joint, commandedDegFromNode(currentRig[joint]));
      }
    }, 200);
    return () => clearInterval(id);
  }, [traceStore]);

  // ------------------------------------------------------------- callbacks
  const onReady = useCallback((next: SceneHandles) => {
    handles.current = next;
    setRig(next.rig);
    setFacts(next.facts);
  }, []);

  const runCommand = useCallback(
    async (name: string): Promise<void> => {
      const current = backendRef.current;
      if (current === null) return;
      setError(null);
      setBusy(name);
      // Mint the id BEFORE the command so the trace exists while events arrive.
      const traceId = traceStore.mintTraceId(name);
      traceStore.open({
        traceId,
        command: name,
        backendId: current.id,
        emulatorOrigin: current.emulatorFacts()?.origin ?? null,
        // Only the QEMU backend actually issues the firmware's HTTP route; the
        // others get an `inferred` row saying so rather than a plausible lie.
        usesHttpRoute: current.id === 'qemu',
      });
      setShownTraceId(traceId);
      lessonRuntime.noteAction('command', name, { command: name, traceId });
      try {
        await current.command(name, { traceId });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [traceStore],
  );

  const runFace = useCallback(
    async (name: string): Promise<void> => {
      const current = backendRef.current;
      if (current === null) return;
      setError(null);
      // `frameAtRequest` is the whole of `face-reselect`: TN-013 says
      // `setFace()` early-returns on the same name, so the animation does NOT
      // restart — and the only way to see that is to know which frame it was on
      // when the second request went in.
      lessonRuntime.noteAction('set-face', `face ← ${name}`, {
        face: name,
        frameAtRequest: modelReading.current?.faceFrame ?? 0,
      });
      try {
        await current.setFace(name);
        // A zero-frame face emits no telemetry whatsoever, so the store would
        // otherwise never hear that anything was attempted. See
        // TelemetryStore.noteFaceRequest.
        store.noteFaceRequest(name);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [store, lessonRuntime],
  );

  const runSetJoint = useCallback(
    async (joint: JointName, deg: number): Promise<void> => {
      const current = backendRef.current;
      if (current === null) return;
      // Journalled BEFORE the call, with the subtrim in force at the moment of
      // the request. `commanded-angle-collision` needs both halves — what was
      // asked for, and what came back — and the second one is the telemetry
      // event, not this record.
      lessonRuntime.noteAction('set-joint', `${joint} ← ${String(deg)}°`, {
        joint,
        requestedDeg: deg,
        subtrimDeg: lessonRuntime.subtrimDeg[joint],
      });
      try {
        await current.setJoint(joint, deg);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [lessonRuntime],
  );

  const stopMotion = useCallback((): void => {
    const current = backendRef.current;
    if (current instanceof SimBackend) current.stopMotion();
  }, []);

  // ============================================================ Learn mode
  //
  // Everything below is a capability handed to the lesson runner. It owns none
  // of it: the pane calls these, and reads the same stores every other pane
  // reads, so a check can never be satisfied by the runner's own bookkeeping.

  /**
   * Write a raw channel index, including one the firmware's guard drops.
   *
   * `setServoAngle()` wraps its whole body in `if (channel < 8)` — no else, no
   * log, no return code — and `@sesame-lab/sesame-sim`'s machine reproduces
   * that with `if (jointAtIndex(channel) === undefined) return;`. The model's
   * only typed entry point is by joint name, so the guard is applied here at
   * the same place and for the same reason, and the action is journalled either
   * way so `telemetry-absent` can tell a dropped write from an unsent one.
   */
  const runSetChannel = useCallback(
    async (channel: number, deg: number): Promise<void> => {
      const joint = Number.isInteger(channel) ? JOINT_ORDER[channel] : undefined;
      lessonRuntime.noteAction('set-channel', `setServoAngle(${String(channel)}, ${String(deg)})`, {
        channel,
        requestedDeg: deg,
        joint: joint ?? null,
        reached: joint !== undefined,
        afterAction: `setServoAngle(${String(channel)}, ${String(deg)})`,
      });
      if (joint === undefined) return;
      const current = backendRef.current;
      if (current === null) return;
      try {
        await current.setJoint(joint, deg);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [lessonRuntime],
  );

  const setLessonSubtrim = useCallback(
    (joint: JointName, deg: number): void => {
      const current = backendRef.current;
      if (current instanceof SimBackend) current.setSubtrim(joint, deg);
      lessonRuntime.setSubtrim(joint, deg);
    },
    [lessonRuntime],
  );

  const setLessonBoard = useCallback(
    (board: string): void => {
      lessonRuntime.setBoard(board, SERVO_PINS_BY_BOARD[board] ?? {});
    },
    [lessonRuntime],
  );

  /** Recomputed here, from the library's own arithmetic. Nothing is passed in. */
  const probePwm = useCallback(
    (angleDeg: number): void => {
      const q = quantiseCommandedAngle(Math.max(0, Math.min(180, Math.round(angleDeg))));
      lessonRuntime.notePwmProbe({
        angleDeg: q.commandedDeg,
        mappedUs: q.mappedUs,
        ticks: q.ticks,
        pulseUs: q.pulseUs,
        aliases: q.aliases,
      });
    },
    [lessonRuntime],
  );

  /**
   * Run an authored sequence, then read the terminal pose back off telemetry.
   *
   * One `setServoAngle()` per channel in firmware enum order, then the wait —
   * because that is all the firmware has. The pose recorded afterwards is the
   * store's, not the document's: `sequence-variation` compares two runs, and
   * comparing what was *authored* would prove nothing.
   */
  const runSequence = useCallback(
    async (doc: SequenceDoc, changedField: string | null): Promise<void> => {
      const current = backendRef.current;
      if (current === null) return;
      const started = lessonRuntime.noteAction('run-sequence', doc.name, {
        frames: doc.frames.length,
        changedField,
        basedOnMovement: doc.basedOnMovement,
      });
      const writes = flattenWrites(doc);
      const bad = outOfRangeAngles(doc);
      for (const frame of doc.frames) {
        for (const joint of JOINT_ORDER) {
          const angle = frame.angles[joint];
          if (angle === undefined) continue;
          if (angle < 0 || angle > 180 || !Number.isInteger(angle)) continue;
          try {
            await current.setJoint(joint, angle);
          } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, frame.delayMs)));
      }
      const commanded = lessonRuntime
        .eventsAfter(started)
        .filter((event) => event.type === 'servo.target' && event.joint !== null)
        .map((event) => ({ joint: event.joint as JointName, angleDeg: event.angleDeg ?? 0 }));
      lessonRuntime.noteSequenceRun({
        t: Date.now(),
        label: doc.name,
        basedOnMovement: doc.basedOnMovement,
        changedField,
        frameCount: doc.frames.length,
        outOfRangeCount: bad.length,
        terminalPose: Object.fromEntries(
          JOINT_ORDER.map((joint) => [joint, store.joints[joint].commandedDeg]),
        ) as Record<JointName, number | null>,
        commanded: commanded.length > 0 ? commanded : writes.map((w) => ({ joint: w.joint, angleDeg: w.angleDeg })),
      });
    },
    [lessonRuntime, store],
  );

  /**
   * A real request to this page's origin, recorded with the real status.
   *
   * The firmware's ten routes only exist in front of a robot, which means
   * `apps/web/server/lab-host.mjs`. Served from anywhere else there is no
   * `/api/status`, and this records the 404 or the network error rather than
   * synthesising a reply — which is the difference between an API console and a
   * prop.
   */
  const sendHttp = useCallback(
    async (method: string, route: string, body: string | null): Promise<void> => {
      const commandWord = body === null ? null : /"command"\s*:\s*"([^"]*)"/.exec(body)?.[1] ?? null;
      lessonRuntime.noteAction('http', `${method} ${route}`, {
        method,
        route,
        commandWord,
      });
      let status: number | null = null;
      let error: string | null = null;
      let text = '';
      try {
        const response = await fetch(route, {
          method,
          ...(body === null ? {} : { body, headers: { 'content-type': 'application/json' } }),
        });
        status = response.status;
        text = await response.text();
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
      let json: unknown = null;
      let jsonError: string | null = null;
      try {
        json = JSON.parse(text);
      } catch (e: unknown) {
        jsonError = e instanceof Error ? e.message : String(e);
      }
      lessonRuntime.noteHttp({
        t: Date.now(),
        method,
        route,
        body,
        status,
        error,
        responseText: text,
        json,
        jsonError,
        // Sampled at the moment the reply LANDED. `/api/status` answered from
        // inside `delayWithFace()` is the whole point of the step.
        duringMovement: modelReading.current?.runningMovement ?? null,
      });
    },
    [lessonRuntime],
  );

  const runBoot = useCallback((): void => {
    const run = runBootModel(BOOT_ORDER, [...lessonRuntime.faults]);
    lessonRuntime.noteAction('boot', 'boot the robot', { faults: run.faults.join(',') });
    lessonRuntime.noteBootRun({ ...run, t: Date.now() });
  }, [lessonRuntime]);

  const pushPixelFrame = useCallback(
    (frame: Uint8Array): void => {
      store.writeAuthoredFrame(renderAuthoredBitmap(frame));
      oledDirty.current += 1;
    },
    [store, oledDirty],
  );

  // ------------------------------------------------------------ debug hook
  useEffect(
    () =>
      installDebugHook({
        store,
        traceStore,
        rig: () => handles.current?.rig ?? null,
        facts: () => handles.current?.facts ?? null,
        renderStats: () => handles.current?.renderStats() ?? null,
        worldFrame: () => handles.current?.worldFrame() ?? null,
        oledCanvas: () => oledCanvas,
        backendId: () => backendId,
        status: () => backendRef.current?.status ?? status,
        emulatorFacts: () => backendRef.current?.emulatorFacts() ?? null,
        lessonRuntime,
        setBackend: async (id, url) => {
          if (url !== undefined) {
            if (id === 'qemu') setLabUrl(url);
            else setBridgeUrl(url);
          }
          // Through the same door a reader's click goes through, so a probe
          // that lands after the harness has chosen cannot override it.
          chooseBackend(id);
          // Give the effect a turn of the event loop to tear down and rebuild.
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        run: (command) => runCommand(command),
        setFace: (name) => runFace(name),
        setJoint: (joint, deg) => runSetJoint(joint, deg),
        stop: stopMotion,
        reset: () => {
          store.reset();
          traceStore.reset();
        },
        selection: () => selection,
        selectJoint: (joint) => selectJointFrom(joint, 'scene'),
        selectNode: (nodeId) => applySelection(selectNode(nodeId, 'graph')),
        selectSymbol: (symbolId) => selectSymbolFrom(symbolId),
        expanded: () => [...expanded],
        toggleNode: (id) => toggleExpanded(id),
        shellBreakpoint: () => shell.breakpoint,
        shellActiveModule: () => shell.activeModule,
        shellPanelVisible: () => shell.panelVisible,
        shellSheets: () => shell.sheets,
        shellMode: () => shell.mode,
        setModule: (id) => shell.setModule(id),
        setSection: (id, open) => shell.setSection(id, open),
        setDockOpen: (dock, open) => shell.setDockOpen(dock, open),
      }),
    [
      shell,
      applySelection,
      backendId,
      chooseBackend,
      expanded,
      oledCanvas,
      runCommand,
      runFace,
      runSetJoint,
      selectJointFrom,
      selectSymbolFrom,
      selection,
      status,
      stopMotion,
      store,
      toggleExpanded,
      traceStore,
    ],
  );

  const canDriveFromSimulated = JOINT_ORDER.some((j) => store.joints[j].simulatedDeg !== null);
  const emulatorFacts = backend?.emulatorFacts() ?? null;
  // The panel is elided when the backend says so — never inferred from the
  // backend's identity. `oledFramebuffer: false` and `ssd1306-panel` in
  // `elided` are two independent statements of the same fact, and either one is
  // enough to stop host-drawn pixels being presented as the emulator's.
  /*
    Derived from the capability document, in one place, by a tested pure
    function — Phase 4 W8. `oled/pixel-provenance.ts` carries the reasoning; the
    property that matters here is that a QEMU image built with
    `SESAME_TELEMETRY_OLED` enabled reports `oledFramebuffer: true`, drops
    `ssd1306-panel` from `elided` and sends `oled.frame`, and every surface below
    changes what it says with no edit in this file.
  */
  const oledOrigin = pixelOrigin(emulatorFacts, store.oledSource);

  /*
    ...and the store is told the same thing, because it has to decide something
    BEFORE this function runs — Phase 4 W5.

    'pixelOrigin' describes what already happened; 'declareOledFramebuffer'
    decides whether a host-side render happens at all. Under the default
    'cli-oled' image a 'face.expression' and an 'oled.frame' arrive for the same
    face change, so without this the app drew the bitmap host-side and labelled
    it 'inferred' for the 120-220 ms until the guest's own buffer landed and
    relabelled it 'observed' — which on an animated face is a badge alternating
    several times a second. See TelemetryStore's own comment.

    Keyed on the VALUE rather than on the facts object, so a backend that
    re-reports the same capability does not re-notify, and a switch to the
    simulator (facts null -> false) does.
  */
  const oledFramebufferDeclared = emulatorFacts?.oledFramebuffer === true;
  useEffect(() => {
    store.declareOledFramebuffer(oledFramebufferDeclared);
  }, [store, oledFramebufferDeclared]);

  const traces = traceStore.traces;
  const shownTrace = traces.find((t) => t.id === shownTraceId) ?? traces[0] ?? null;

  /**
   * Put every lab-side modification back.
   *
   * Three kinds, and the third is Lab mode's: subtrim, injected faults, and an
   * authored face sitting on the panel where the robot's own would be. The
   * panel is restored by REDRAWING the face the robot last reported rather
   * than by blanking it — a blank panel is itself a state no firmware
   * produces, and `setFace()` early-returns on the same name (TN-013) so
   * re-requesting it would emit nothing at all.
   */
  const clearLabModifications = useCallback((): void => {
    for (const joint of JOINT_ORDER) setLessonSubtrim(joint, 0);
    for (const fault of [...lessonRuntime.faults]) lessonRuntime.setFault(fault, false);
    if (store.panelIsAuthored) {
      store.repaintReportedFace();
      oledDirty.current += 1;
    }
  }, [lessonRuntime, setLessonSubtrim, store, oledDirty]);

  /** Stable across renders, so the Lab pane subscribes once and not per frame. */
  const subscribeToLabState = useCallback(
    (listener: () => void) => lessonRuntime.subscribe(listener),
    [lessonRuntime],
  );

  const lessonWiring: LessonWiring = {
    runtime: lessonRuntime,
    joints: store.joints,
    model: modelReading.current,
    trace: shownTrace,
    selection,
    busy,
    showTopCover,
    // Stated, never hidden: the bridge and QEMU backends have no lab-reachable
    // subtrim, and the control says so instead of silently doing nothing.
    canSetSubtrim: backend instanceof SimBackend,
    runCommand,
    setJoint: runSetJoint,
    setChannel: runSetChannel,
    setFace: runFace,
    setSubtrim: setLessonSubtrim,
    setBoard: setLessonBoard,
    clearLabModifications,
    selectSymbol: selectSymbolFrom,
    followTraceRow: (symbolId) => {
      const symbol = SYMBOL_BY_ID.get(symbolId);
      if (symbol === undefined) return false;
      const row = (shownTrace?.rows ?? EMPTY_ROWS).find(
        (r) => r.sourceRef !== null && symbolContains(symbol, r.sourceRef.file, r.sourceRef.line),
      );
      if (row === undefined) return false;
      applySelection(selectSymbol(symbolId, 'trace'));
      return true;
    },
    selectNode: (nodeId) => applySelection(selectNode(nodeId, 'graph')),
    selectJoint: (joint) => selectJointFrom(joint, 'scene'),
    onToggleTopCover: setShowTopCover,
    probePwm,
    runSequence,
    sendHttp,
    runBoot,
    pushPixelFrame,
  };

  /**
   * Lab mode's wiring.
   *
   * The same discipline as `lessonWiring`: the pane sees live readings off the
   * stores every other pane reads, and everything it can DO is a function from
   * here. Lab sets far more state than Learn does — eight sliders, subtrim,
   * faults, an authored panel, arbitrary HTTP — which is exactly why it must
   * not own any of it.
   */
  // One snapshot, not three: this object is rebuilt on every App render and
  // `snapshot()` allocates.
  const labSnapshot = lessonRuntime.snapshot();
  const labWiring: LabWiring = {
    commandedDeg: Object.fromEntries(
      JOINT_ORDER.map((joint) => [joint, store.joints[joint].commandedDeg]),
    ) as Record<JointName, number | null>,
    subtrimDeg: lessonRuntime.subtrimDeg,
    faults: lessonRuntime.faults,
    httpExchanges: labSnapshot.http,
    bootLog: labSnapshot.bootRuns.at(-1)?.log ?? [],
    bootHaltedAt: labSnapshot.bootRuns.at(-1)?.haltedAt ?? null,
    busy,
    canSetSubtrim: backend instanceof SimBackend,
    panelAuthored: store.panelIsAuthored,
    setJoint: runSetJoint,
    setSubtrim: setLessonSubtrim,
    setFault: (id, on) => lessonRuntime.setFault(id, on),
    runBoot,
    runSequence,
    sendHttp,
    pushPixelFrame,
    clearLabModifications,
    selectSymbol: selectSymbolFrom,
    subscribe: subscribeToLabState,
  };

  /**
   * Which architecture nodes the shown trace touched.
   *
   * This is the report's "the same graph becomes the See the Signal canvas":
   * the trace does not get its own diagram, it lights the path on this one.
   *
   * Keyed by CONTENT, not by the trace object. A running wave rewrites its rows
   * several times a second while the *set of nodes they touch* stops growing
   * after the first servo write — and a fresh `Set` identity each tick would
   * rebuild every React Flow node object at 6 Hz. Under SwiftShader that is
   * frames the 3D view needs.
   */
  const activeKey = useMemo(() => {
    const ids = new Set<string>();
    for (const row of shownTrace?.rows ?? []) {
      if (row.nodeId !== null) ids.add(row.nodeId);
    }
    return [...ids].sort().join('|');
  }, [shownTrace]);
  const activeNodeIds = useMemo(
    () => new Set(activeKey.length === 0 ? [] : activeKey.split('|')),
    [activeKey],
  );

  /*
   * The focus workspace closes itself when its pane leaves the screen.
   *
   * It is a temporary arrangement, not a stored preference: a reader who
   * switches to Signal, or shuts the workbench, has ended the task the
   * workspace existed for, and leaving the stage at a fifth of the screen
   * because of a mode nothing on screen still mentions would be exactly the
   * "robot must dominate" failure the exemption is narrow to avoid. It is also
   * what keeps `data-stage-rule` honest: the exemption is claimed only while
   * the pane that justifies it is visible.
   */
  const focusPaneVisible = focusPane === null ? false : shell.isVisible(focusPane);
  useEffect(() => {
    if (focusPane !== null && !focusPaneVisible) setFocusPane(null);
  }, [focusPane, focusPaneVisible]);

  // ------------------------------------------------- collapsed-section state
  //
  // Section 5.1, and the other half of section 4's "collapsing costs no
  // awareness". A closed header still says what its pane holds: which joint is
  // selected, how many trace rows the selection hit, how far the open lesson
  // has got, and whether Sesame Lab is currently modifying this robot. Every
  // one of these is read from state that already existed - `SelectionState`,
  // the trace store, the lesson progress record and the lesson runtime - so a
  // badge cannot say something its own pane would contradict.
  const hitRowCount = (shownTrace?.rows ?? EMPTY_ROWS).filter(
    (row) =>
      (selection.joint !== null && row.joint === selection.joint) ||
      (selection.nodeId !== null && row.nodeId === selection.nodeId),
  ).length;

  const learnBadge = useMemo(() => {
    const progress = loadProgress();
    const open = progress.openLessonId === null ? undefined : LESSON_BY_ID.get(progress.openLessonId);
    if (open !== undefined) {
      const p = lessonProgress(progress, open);
      return `${open.title} ${String(p.passed)}/${String(p.total)}`;
    }
    const passed = LESSONS.reduce((n, lesson) => n + lessonProgress(progress, lesson).passed, 0);
    return passed === 0 ? `${String(LESSONS.length)} lessons` : `${String(passed)} steps passed`;
    // Recomputed on the panel tick, which is also the rate the lesson runner
    // repaints at. Progress lives in localStorage and nothing else notifies.
  }, [tick]);

  const labModificationCount =
    JOINT_ORDER.filter((joint) => lessonRuntime.subtrimDeg[joint] !== 0).length +
    lessonRuntime.faults.size +
    (store.panelIsAuthored ? 1 : 0);

  const commandCount = COMMAND_VOCABULARY.filter((c) => c.command !== '').length;

  /*
   * ================================================ THE SIDE PANEL — W7
   *
   * Commands, the face, and a glance at the selected joint. ~280 px, always
   * visible above Compact, and ZERO scrollers at every width — §11.4 is
   * explicit that a content problem here is solved by disclosure and not by a
   * scrollbar, so each card carries a "more info" screen and each card's body
   * is a fixed number of rows rather than a list that grows.
   *
   * The TRUST card is rendered separately, because it is the one §11.4 protects
   * by name and it must not be reachable only through a disclosure of its own.
   *
   * ## The FACE is first — Phase 4 W8
   *
   * > *"The face should be at the very top."*
   *
   * W7 drew the trust card first and called that a consequence of §11.4. It is
   * not: §11.4 is about a correctness surface being VISIBLE on the panel rather
   * than behind a disclosure, and it says nothing about which card is at the
   * top. The trust card is still on the panel, still unfoldable, still carrying
   * all four of its named surfaces, and the harness still reads every one of
   * them with every screen shut — so the invariant is untouched and only the
   * order changed. What the order buys is the thing the reader asked for: the
   * 128x64 glass is the surface you watch while you press a command, and it was
   * 190 px down the panel.
   */
  const panelCards: readonly PanelCardSpec[] = [
    {
      id: 'face',
      label: 'Face',
      /*
        `4x`, not `Larger` — Phase 4 W8, and it is 28 px of panel.

        The header holds the label, the face name, the pixel-provenance badge,
        the info icon and the two zero-frame faces in 280 px; with `Larger` it
        wrapped to a second line at every window, and the 28 px that cost is
        exactly what pushed the joint glance into a fold at 1760x1000. It also
        names what the screen actually is — "The virtual OLED, at 4x".
      */
      more: { label: '4×', onOpen: () => setPopover('face') },
      /*
        The pixels' own provenance, and it is DERIVED — `inferred` on today's
        QEMU image because it models no SSD1306, `observed` the moment an image
        built with `SESAME_TELEMETRY_OLED` reports `oledFramebuffer: true` and
        starts sending `oled.frame`. Nothing here names a backend.

        The BADGE is the correctness surface and it stays on this summary at
        every width, folded or not. The two paragraphs that explain it are
        behind the `ⓘ` beside it — hover, focus or click — which is Phase 4 W8
        and the user's own request.
      */
      /*
        THE FACE NAME IS NOT HERE ANY MORE — Phase 4 W5.

        > *"When it does that, its html container resizes causing everything
        > else to shift position, bouncing up and down."*

        The header is a wrapping flex row 262 px wide, and the face name is the
        one thing in it whose LENGTH is live telemetry: measured at 1440x900,
        `happy` left the card 213 px tall and `sleepy` left it 241, because six
        characters instead of five wrapped the row to a second line and every
        card below moved with it. The firmware's idle-blink animation changes
        that name several times a second.

        So the name moved into the card's BODY, on a row whose height is one
        line whatever it holds (`.panel-face-name`). What stays on the header is
        the badge, the info icon and the zero-frame mark — a fixed set of
        elements whose vocabulary is fixed, and whose one remaining variation
        (`inferred` / `observed` / `simulated`) is pinned to a constant width by
        `.panel-card-summary .prov`. The header cannot change height, so the
        cards below it cannot move.
      */
      summary: (
        <>
          {store.oledSource.pixelProvenance === null ? (
            <span className="muted">no pixels</span>
          ) : (
            <ProvenanceTag value={store.oledSource.pixelProvenance} />
          )}
          <span data-pixel-origin={oledOrigin.state} data-from-emulator={String(oledOrigin.fromEmulator)}>
            <InfoDot
              id="oled-pixels"
              label="Where did these pixels come from?"
              tip={oledOrigin.claim}
              onOpen={() => setPopover('oled-pixels')}
            />
          </span>{' '}
          {/*
            The zero-frame fact rides on the SUMMARY as well as in the card, so
            it survives a fold. Two of the firmware's 38 faces draw nothing at
            all (ISSUE-20260823-004) and that may not be a thing a reader has to
            open a screen to find out.
          */}
          <span
            className="panel-summary-warn"
            data-zero-frame-faces="2"
            title="setFace('stand') and setFace('default') draw nothing — the bitmap is weak-undefined (ISSUE-20260823-004)"
          >
            ⚠2
          </span>
        </>
      ),
      body: (
        <>
          <OledPanel
            variant="panel"
            panel={store.panel}
            textureCanvas={oledCanvas}
            face={store.face}
            source={store.oledSource}
            emptyFace={store.emptyFace}
            origin={oledOrigin}
            version={store.version}
            onRedraw={() => {
              oledDirty.current += 1;
            }}
          />
        </>
      ),
    },
    {
      id: 'commands',
      label: 'Commands',
      more: { label: `All ${String(commandCount)}`, onOpen: () => setPopover('commands') },
      /*
        The mark that survives a fold: two of the firmware's faces have zero
        frames and draw nothing at all (ISSUE-20260823-004). The ⚠ buttons say
        so when the card is open; this says so when it is not.
      */
      /* Folded, the card still says whether this backend can command at all —
         the receive-only bridge is a correctness surface, not a disabled state. */
      summary:
        backend !== null && !backend.canCommand ? (
          <span className="panel-summary-warn">receive-only</span>
        ) : busy !== null ? (
          <span>running {busy}</span>
        ) : null,
      body:
        backend === null ? null : (
          <CommandBar
            variant="panel"
            backend={backend}
            status={status}
            busy={busy}
            error={error}
            onCommand={(name) => void runCommand(name)}
            onFace={(name) => void runFace(name)}
            onStop={stopMotion}
          />
        ),
    },
    {
      id: 'inspector',
      label: 'Selected joint',
      more: { label: 'All 8', onOpen: () => setPopover('inspector') },
      summary:
        selected === null ? (
          <span className="muted">none</span>
        ) : (
          <>
            <b>{selected}</b>{' '}
            {store.joints[selected].provenance !== null && (
              <ProvenanceTag value={store.joints[selected].provenance} />
            )}
          </>
        ),
      body: (
        <JointGlance
          joints={store.joints}
          selected={selected}
          totalEvents={store.totalEvents}
          jointsCommanded={JOINT_ORDER.filter((j) => store.joints[j].commandedDeg !== null).length}
        />
      ),
    },
  ];

  /*
   * ==================================================== THE MODULES — W7
   *
   * `Architecture · Signal · Source · Learn · Lab`, mutually exclusive.
   *
   * The exclusivity is structural rather than enforced: `ShellState` holds one
   * nullable id, so a two-open state is not representable and therefore not
   * reachable. The rail's radiogroup is the only way to change it.
   *
   * The Lab is in the set because it is a large EDITING surface — a pose table,
   * a pixel editor, a C++ round trip — and not a glance surface. §11.3 asks for
   * that to be flagged if it proves wrong on screen; it does not. At 535 px of
   * column at 1440x900 the pose table has room it never had in a 400 px dock.
   */
  const modules: readonly ModuleSpec[] = [
    {
      id: 'modules',
      label: MODULE_LABEL.modules,
      note: selection.nodeId ?? null,
      noteIsSelection: selection.nodeId !== null,
      body: (
        <ArchitectureGraph
          expanded={expanded}
          onToggle={toggleExpanded}
          selection={selection}
          onSelect={(nodeId) => applySelection(selectNode(nodeId, 'graph'))}
          activeNodeIds={activeNodeIds}
          trace={shownTrace}
          onSelectRow={selectTraceRow}
          workspaceOpen={focusPane === 'modules'}
          onWorkspaceChange={(open) => setFocusPane(open ? 'modules' : null)}
        />
      ),
    },
    {
      id: 'signal',
      label: MODULE_LABEL.signal,
      /*
        W5: the ladder is a SEQUENCE of steps, and the title says so. The count
        of steps is derived from the rows the pane will actually group rather
        than from `TRACE_LAYERS.length`, because a trace that never reached
        `visual.joint` has seven rungs and a title claiming eight would be the
        chrome contradicting the pane under it.
      */
      note:
        hitRowCount > 0
          ? `${String(hitRowCount)} rows`
          : `${String(new Set((shownTrace?.rows ?? EMPTY_ROWS).map((r) => r.layer)).size)} steps · ` +
            `${String(shownTrace?.rows.length ?? 0)} rows`,
      noteIsSelection: hitRowCount > 0,
      body: (
        <SignalTrace
          trace={shownTrace}
          traces={traces}
          selection={selection}
          onSelectRow={selectTraceRow}
          onSelectTrace={setShownTraceId}
        />
      ),
    },
    {
      id: 'source',
      label: MODULE_LABEL.source,
      note: selection.symbolId,
      noteIsSelection: selection.symbolId !== null,
      body: (
        <SourceExplorer
          selection={selection}
          onSelectSymbol={selectSymbolFrom}
          onSelectNode={(nodeId) => applySelection(selectNode(nodeId, 'source'))}
          onSelectJoint={(joint) => selectJointFrom(joint, 'inspector')}
          traceRows={shownTrace?.rows ?? EMPTY_ROWS}
          onSelectRow={selectTraceRow}
          /*
            The module column is `[data-sections='one']` — one pane owning one
            column behind one scroller — so the code view has no scrollbar of
            its own below Wide and what bounds it is a LINE BUDGET the pane
            announces and a button can lift. At Wide the pixel box is back and
            is what L4 measures its scroll assertion against.
          */
          lineBudget={shell.breakpoint === 'wide' ? 240 : 140}
        />
      ),
    },
    {
      id: 'learn',
      label: MODULE_LABEL.learn,
      note: learnBadge,
      noteIsSelection: false,
      body: <LessonRunner wiring={lessonWiring} />,
    },
    {
      id: 'lab',
      label: MODULE_LABEL.lab,
      note:
        labModificationCount === 0
          ? 'robot unmodified'
          : `${String(labModificationCount)} modification${labModificationCount === 1 ? '' : 's'}`,
      noteIsSelection: labModificationCount > 0,
      body: <LabMode wiring={labWiring} />,
    },
  ];

  /**
   * §5.1 — a selection that landed in a module the reader is not looking at.
   *
   * Only SELECTION badges reach the rail, never counts: `Arch ● R4` is the
   * thing a reader would otherwise miss, and "8 rows" beside every glyph is the
   * density the brief is complaining about. The note is still on the module's
   * own title, where the module is.
   */
  const moduleBadges: Partial<Record<ModuleId, string>> = {};
  for (const module of modules) {
    if (module.noteIsSelection && module.note !== null) moduleBadges[module.id] = module.note;
  }

  return (
    <div
      className="shell"
      data-testid="shell"
      data-breakpoint={shell.breakpoint}
      data-active-module={shell.activeModule ?? ''}
      data-panel-open={String(shell.panelVisible)}
      data-dock-overlay={String(shell.sheets)}
      data-shell-regime="module-first"
      data-workbench-mode={shell.mode}
      data-focus-pane={focusPane ?? ''}
      /*
        WHICH STAGE RULE IS IN FORCE — §11.2, published rather than inferred.

          area-50     no module active: the stage keeps >= 50% of the VIEWPORT
          content-50  a module is active: >= 50% of the CONTENT area, which is
                      the viewport minus the rail, the status strip and the side
                      panel — the plain reading of "with the robot in the other
                      half"
          focus-exempt  W4's focus workspace, the brief's sanctioned exception

        The two are NOT averaged into one loose threshold. The app declares
        which one it is claiming and the harness asserts the declaration against
        the measured layout; a harness that decided the regime for itself would
        branch on the same condition the layout branches on and could never
        disagree with it.
      */
      data-stage-rule={stageRuleFor(shell.activeModule, focusPane)}
    >
      {/*
        The rail/stage/workbench row. The status line is a sibling BELOW it
        rather than a strip inside the stage — Phase 4 W3 — because that is the
        plan's own geometry (a 900 px window is 868 px of stage and 32 px of
        status) and because the environment line needs the whole width.
      */}
      <div className="shell-main" data-testid="shell-main">
      <Rail
        shell={shell}
        backendId={backendId}
        onBackendChange={chooseBackend}
        status={status}
        drivingProvenance={store.drivingProvenance}
        drivingOrigin={store.drivingOrigin}
        totalEvents={store.totalEvents}
        moduleBadges={moduleBadges}
      />

      {/*
        The CONTENT area: the stage and the one active module, and nothing else.

        It is a box of its own rather than three siblings in one row because
        §11.2's rule is about this box: with a module active the stage keeps
        >= 50% of the CONTENT area, and the two children are `flex: 1 1 0` with
        `min-width: 0` on the module, so the split is 50/50 by construction and
        the stage's own 480 px floor is what it gives way to. A rule stated as
        structure cannot drift from a rule stated as arithmetic.
      */}
      <div className="content" data-testid="content">

      {/*
        The stage, and it really is a stage now — Phase 4 W3.

        U6 floated the docks so this box never lost a pixel below Wide. The
        user replaced that rule with a better one: *"I'd rather the robot area
        shrink. 50% of the screen area is more than enough."* So the workbench
        is in flow, this box genuinely resizes when it opens, and what the
        harness asserts is the stage's share of the screen AREA rather than the
        absence of a push.

        ISSUE-20260823-023 was a sliding ground plane found by a user AFTER a
        layout change. It is MORE load-bearing now, not less: the canvas
        resizes on every workbench open, every mode switch that changes the
        navigator's height, and every dock drag at Wide, so phase 12 sweeps the
        world frame at every breakpoint and across every one of those.
      */}
      <main className="stage" data-testid="stage">
        <div className="viewport" data-testid="viewport">
          <Suspense fallback={<div className="loading">loading assets/sesame.glb…</div>}>
            <RobotScene
              store={store}
              litJoints={litJoints}
              onSelect={(joint) => selectJointFrom(joint, 'scene')}
              oledCanvas={oledCanvas}
              oledDirty={oledDirty}
              driveFrom={driveFromSimulated && canDriveFromSimulated ? 'simulated' : 'commanded'}
              onReady={onReady}
              showTopCover={showTopCover}
            />
          </Suspense>
          <div className="viewport-caption">
            <b>Sesame Lab</b> · kinematics only, no physics · click a joint to inspect it ·{' '}
            {driveFromSimulated && canDriveFromSimulated
              ? 'showing the model’s slew estimate (simulatedDeg)'
              : 'showing commanded angles'}
          </div>
        </div>
        </main>

        <ModuleColumn shell={shell} modules={modules} />
      </div>

      <SidePanel
        shell={shell}
        trust={
          <TrustCard
            drivingProvenance={store.drivingProvenance}
            drivingOrigin={store.drivingOrigin}
            physicallyObservedEvents={store.physicallyObservedEvents}
            /*
              The default is QEMU; this is the state where the origin has no
              QEMU behind it. Both halves are required: the guidance is about
              the LAB HOST, so it has no business appearing while the reader is
              deliberately on the bridge or the simulator.
            */
            noLabHost={backendId === 'qemu' && labProbe?.labHost === 'absent'}
            /*
              Phase 5 T1. The desktop shell picked the behavioural simulator
              because it has no emulator backend yet, and it may not do that
              quietly — see `backends/default-backend.ts`. Read off the probe
              rather than off `detectDesktopShell()` so a reader who switches
              backend by hand stops seeing a line about a choice they replaced.
            */
            desktopSimulator={backendId === 'sim' && labProbe?.labHost === 'desktop'}
            onMore={() => setPopover('trust')}
          />
        }
        cards={panelCards}
      />
      </div>

      {/*
        The status line. 32 px, never scrolls, never wraps, spans the whole
        shell, and its content scales with the breakpoint rather than with its
        own box - see `ui/StatusBar.tsx`.

        It carries the ENVIRONMENT LINE - `SYSTEM: ... · PHYSICAL HARDWARE:
        NONE` - which is a correctness surface rather than a glance value. The
        brief's point is that a novice reads "observed" as *observed on
        hardware*, so the two facts that decide how to read every other number
        on screen are stated in words, permanently, in a region that never
        closes, and not in a legend.
      */}
      <StatusBar
        breakpoint={shell.breakpoint}
        status={status}
        backendId={backendId}
        drivingProvenance={store.drivingProvenance}
        drivingOrigin={store.drivingOrigin}
        provenanceCounts={store.provenanceCounts}
        originCounts={store.originCounts}
        totalEvents={store.totalEvents}
        physicallyObservedEvents={store.physicallyObservedEvents}
        emulatorFacts={emulatorFacts}
        groundPlaneMm={groundPlaneMm}
        jointsCommanded={JOINT_ORDER.filter((j) => store.joints[j].commandedDeg !== null).length}
        jointCount={JOINT_ORDER.length}
        selectedJoint={selected}
        selectedJointDeg={selected === null ? null : store.joints[selected].commandedDeg}
        canCommand={backend?.canCommand ?? false}
        busy={busy}
        onCommand={(name) => void runCommand(name)}
        onStop={stopMotion}
      />

      {/*
        ================================================ "MORE INFO" — §11.4

        Three screens, each opened from the card it expands. They are siblings
        of the shell's columns rather than children of the side panel, which is
        what keeps the panel's scroller inventory a statement about the panel: a
        closed `<dialog>` is `display: none`, so nothing inside one has a box,
        is counted as a scroller, or is measured by the type scan.

        What is in here is DETAIL, never a first appearance. The driving
        provenance, the origin with its board, `measurementVerdict()`,
        `PHYSICAL HARDWARE: NONE`, the receive-only warning, the two ⚠ faces and
        the "these pixels did not come from the emulator" claim are all on the
        panel itself; these screens add the paragraph, the counts, the table and
        the 4x view.
      */}
      <Popover
        id="trust"
        title="What is driving this scene"
        open={popover === 'trust'}
        onClose={() => setPopover(null)}
      >
        {backend !== null && (
          <BackendPanel
            backend={backend}
            backendId={backendId}
            onBackendChange={chooseBackend}
            bridgeUrl={bridgeUrl}
            onBridgeUrlChange={setBridgeUrl}
            status={status}
            drivingProvenance={store.drivingProvenance}
            drivingOrigin={store.drivingOrigin}
            provenanceCounts={store.provenanceCounts}
            originCounts={store.originCounts}
            totalEvents={store.totalEvents}
          />
        )}
        <EmulatorPanel
          facts={emulatorFacts}
          status={status}
          physicallyObservedEvents={store.physicallyObservedEvents}
        />
      </Popover>

      <Popover
        id="commands"
        title="The whole command vocabulary"
        open={popover === 'commands'}
        onClose={() => setPopover(null)}
      >
        {backend !== null && (
          <CommandBar
            variant="full"
            backend={backend}
            status={status}
            busy={busy}
            error={error}
            onCommand={(name) => void runCommand(name)}
            onFace={(name) => void runFace(name)}
            onStop={stopMotion}
          />
        )}
      </Popover>

      <Popover
        id="face"
        title="The virtual OLED, at 4×"
        open={popover === 'face'}
        onClose={() => setPopover(null)}
      >
        {backend !== null && (
          <FaceBar
            backend={backend}
            status={status}
            busy={busy}
            onFace={(name) => void runFace(name)}
          />
        )}
        <OledPanel
          variant="full"
          panel={store.panel}
          textureCanvas={oledCanvas}
          face={store.face}
          source={store.oledSource}
          emptyFace={store.emptyFace}
          origin={oledOrigin}
          version={store.version}
          onRedraw={() => {
            oledDirty.current += 1;
          }}
        />
      </Popover>

      {/*
        THE INFO SCREEN — Phase 4 W8.

        The fifth `<dialog>`, rendered as a sibling of the shell's columns for
        the same reason as the other four: a closed dialog is `display: none`,
        so nothing inside one has a laid-out box, is counted as a scroller or is
        measured by the type scan, and the side panel's inventory stays a
        statement about the side panel.

        Its content is `PixelOrigin.paragraphs` — DERIVED. The claim it opens
        with is the same string the icon's tip shows, from the same object, so
        the one-line form and the long form cannot say different things. That is
        the discipline W7 applied to `measurementHeadline()` /
        `measurementDetail()`, applied here.
      */}
      <Popover
        id="oled-pixels"
        title="Where these pixels came from"
        open={popover === 'oled-pixels'}
        onClose={() => setPopover(null)}
      >
        <div className="pixel-origin" data-pixel-origin={oledOrigin.state}>
          <p className="pixel-origin-claim" data-testid="pixel-origin-claim">
            <strong>{oledOrigin.claim}</strong>
          </p>
          {oledOrigin.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 24)} className="note">
              {paragraph}
            </p>
          ))}
          <p className="note muted">
            Pixel provenance is <ProvenanceTag value={store.oledSource.pixelProvenance ?? 'inferred'} />{' '}
            — the badge on the Face card says the same word, and it says it whether this screen is
            open or not.
          </p>
        </div>
      </Popover>

      <Popover
        id="inspector"
        title="All eight joints"
        open={popover === 'inspector'}
        onClose={() => setPopover(null)}
      >
        <JointInspector
          joints={store.joints}
          rig={rig}
          selected={selected}
          onSelect={(joint) => selectJointFrom(joint, 'inspector')}
          canCommand={backend?.canCommand ?? false}
          onSetJoint={(joint, deg) => void runSetJoint(joint, deg)}
        />

        <AssetPanel
          facts={facts}
          groundPlaneMm={groundPlaneMm}
          showTopCover={showTopCover}
          onToggleTopCover={setShowTopCover}
          driveFromSimulated={driveFromSimulated}
          onDriveFromSimulated={setDriveFromSimulated}
          canDriveFromSimulated={canDriveFromSimulated}
        />
      </Popover>
    </div>
  );
}
