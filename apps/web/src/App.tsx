/**
 * V3 + V4 (the browser robot) and V8 (the architecture graph + "See the Signal").
 *
 * Layout is the research report's three-pane engineering workbench: the 3D
 * scene on the left, the architecture graph and the causal trace in the middle,
 * and the state inspector on the right.
 *
 * ```text
 * +--------------------+---------------------------+------------------+
 * | Interactive 3D     | Architecture / Signal     | State inspector  |
 * | click any joint    | trace                     | OLED, assets     |
 * +--------------------+---------------------------+                  |
 * | Source explorer — real source at pinned line   | (full height)    |
 * | numbers, symbol <-> node <-> part <-> event    |                  |
 * +------------------------------------------------+------------------+
 * ```
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
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { OLED_HEIGHT, OLED_WIDTH } from '@sesame-lab/sesame-protocol';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { BridgeBackend, sameOriginBridgeUrl } from './backends/bridge-backend.js';
import { defaultLabBaseUrl, QemuBackend } from './backends/qemu-backend.js';
import { SimBackend } from './backends/sim-backend.js';
import type { BackendId, BackendStatus, TelemetryBackend } from './backends/types.js';
import { installDebugHook } from './debug-hook.js';
import { symbolAt } from './source/model.js';
import { expansionsFor } from './arch/layout.js';
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
import { Controls } from './ui/Controls.js';
import { EmulatorPanel } from './ui/EmulatorPanel.js';
import { JointInspector } from './ui/JointInspector.js';
import { OledPanel } from './ui/OledPanel.js';
import { SignalTrace } from './ui/SignalTrace.js';
import { SourceExplorer } from './ui/SourceExplorer.js';

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

  /** The 128x64 canvas that becomes the `CanvasTexture` on `oled_screen`. */
  const oledCanvas = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = OLED_WIDTH;
    canvas.height = OLED_HEIGHT;
    return canvas;
  }, []);
  const oledDirty = useRef(0);

  const [backendId, setBackendId] = useState<BackendId>('sim');
  const [bridgeUrl, setBridgeUrl] = useState(sameOriginBridgeUrl());
  const [labUrl, setLabUrl] = useState(defaultLabBaseUrl());
  const [status, setStatus] = useState<BackendStatus>({
    connection: 'idle',
    detail: 'starting',
    eventsReceived: 0,
  });
  const backendRef = useRef<TelemetryBackend | null>(null);
  const [backend, setBackend] = useState<TelemetryBackend | null>(null);

  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_EXPANSIONS);
  const [shownTraceId, setShownTraceId] = useState<string | null>(null);
  const [showTopCover, setShowTopCover] = useState(true);
  const [driveFromSimulated, setDriveFromSimulated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
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
  const applySelection = useCallback((next: SelectionState) => {
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
  }, []);

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
          return new QemuBackend({ baseUrl: labUrl });
      }
    };
    const next: TelemetryBackend = build();

    // A backend switch is a different robot, not a continuation of the same
    // one. Keeping the previous joint angles would attribute one backend's
    // state to another's provenance — and keeping the previous trace would be
    // worse, because its rows carry the old backend's origins.
    store.reset();
    traceStore.reset();
    setShownTraceId(null);
    backendRef.current = next;
    setBackend(next);
    setStatus(next.status);
    setError(null);

    const offEvent = next.onEvent((event) => {
      store.ingest(event);
      traceStore.ingest(event);
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
  }, [backendId, bridgeUrl, labUrl, store, traceStore]);

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
        if (state !== null) store.applyModelState(state.joints);
      });
    };
    frame = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(frame);
  }, [store]);

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
    [store],
  );

  const runSetJoint = useCallback(async (joint: JointName, deg: number): Promise<void> => {
    const current = backendRef.current;
    if (current === null) return;
    try {
      await current.setJoint(joint, deg);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopMotion = useCallback((): void => {
    const current = backendRef.current;
    if (current instanceof SimBackend) current.stopMotion();
  }, []);

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
        setBackend: async (id, url) => {
          if (url !== undefined) {
            if (id === 'qemu') setLabUrl(url);
            else setBridgeUrl(url);
          }
          setBackendId(id);
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
      }),
    [
      applySelection,
      backendId,
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
  const oledElided =
    emulatorFacts !== null &&
    (!emulatorFacts.oledFramebuffer || emulatorFacts.elided.includes('ssd1306-panel'));

  const traces = traceStore.traces;
  const shownTrace = traces.find((t) => t.id === shownTraceId) ?? traces[0] ?? null;

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

  return (
    <div className="app">
      <div className="viewport">
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

      <div className="workbench">
        <ArchitectureGraph
          expanded={expanded}
          onToggle={toggleExpanded}
          selection={selection}
          onSelect={(nodeId) => applySelection(selectNode(nodeId, 'graph'))}
          activeNodeIds={activeNodeIds}
        />

        <SignalTrace
          trace={shownTrace}
          traces={traces}
          selection={selection}
          onSelectRow={selectTraceRow}
          onSelectTrace={setShownTraceId}
        />
      </div>

      {/*
        The fourth pane. It sits on its own row under the 3D view and the
        workbench rather than inside either, for one reason: the viewport keeps
        its width. ISSUE-20260823-023 was a sliding ground plane, and squeezing
        the column the renderer lives in is the same class of change that
        produced it. This adds a row and leaves the camera's aspect the only
        thing that moves.
      */}
      <SourceExplorer
        selection={selection}
        onSelectSymbol={selectSymbolFrom}
        onSelectNode={(nodeId) => applySelection(selectNode(nodeId, 'source'))}
        onSelectJoint={(joint) => selectJointFrom(joint, 'inspector')}
        traceRows={shownTrace?.rows ?? EMPTY_ROWS}
        onSelectRow={selectTraceRow}
      />

      <aside className="sidebar">
        {backend !== null && (
          <Controls
            backend={backend}
            backendId={backendId}
            onBackendChange={setBackendId}
            bridgeUrl={bridgeUrl}
            onBridgeUrlChange={setBridgeUrl}
            status={status}
            drivingProvenance={store.drivingProvenance}
            drivingOrigin={store.drivingOrigin}
            provenanceCounts={store.provenanceCounts}
            originCounts={store.originCounts}
            totalEvents={store.totalEvents}
            busy={busy}
            error={error}
            onCommand={(name) => void runCommand(name)}
            onFace={(name) => void runFace(name)}
            onStop={stopMotion}
          />
        )}

        <EmulatorPanel
          facts={emulatorFacts}
          status={status}
          physicallyObservedEvents={store.physicallyObservedEvents}
        />

        <JointInspector
          joints={store.joints}
          rig={rig}
          selected={selected}
          onSelect={(joint) => selectJointFrom(joint, 'inspector')}
          canCommand={backend?.canCommand ?? false}
          onSetJoint={(joint, deg) => void runSetJoint(joint, deg)}
        />

        <OledPanel
          panel={store.panel}
          textureCanvas={oledCanvas}
          face={store.face}
          source={store.oledSource}
          emptyFace={store.emptyFace}
          panelElided={oledElided}
          version={store.version}
          onRedraw={() => {
            oledDirty.current += 1;
          }}
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
      </aside>
    </div>
  );
}
