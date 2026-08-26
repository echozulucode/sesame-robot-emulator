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
import { JOINT_ORDER, quantiseCommandedAngle, type JointName } from '@sesame-lab/sesame-model';
import { OLED_HEIGHT, OLED_WIDTH } from '@sesame-lab/sesame-protocol';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { BridgeBackend, sameOriginBridgeUrl } from './backends/bridge-backend.js';
import { defaultLabBaseUrl, QemuBackend } from './backends/qemu-backend.js';
import { SimBackend } from './backends/sim-backend.js';
import type { BackendId, BackendStatus, TelemetryBackend } from './backends/types.js';
import { installDebugHook } from './debug-hook.js';
import { renderAuthoredBitmap } from './oled/framebuffer.js';
import { symbolAt, symbolContains, SYMBOL_BY_ID } from './source/model.js';
import { expansionsFor } from './arch/layout.js';
import { flattenWrites, outOfRangeAngles, type SequenceDoc } from './editors/sequence.js';
import { BOOT_ORDER } from './generated/lessons.js';
import { SERVO_PINS_BY_BOARD } from './generated/architecture-graph.js';
import type { ModelReading } from './lessons/checks.js';
import { LessonRuntime, runBootModel } from './lessons/runtime.js';
import type { LessonWiring } from './lessons/wiring.js';
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
  }, [backendId, bridgeUrl, labUrl, store, traceStore, lessonRuntime]);

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
    clearLabModifications: () => {
      for (const joint of JOINT_ORDER) setLessonSubtrim(joint, 0);
      for (const fault of [...lessonRuntime.faults]) lessonRuntime.setFault(fault, false);
    },
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

      {/*
        Learn mode. A THIRD row, for the same reason the source explorer took a
        second one: a column would have to come out of the viewport's width, and
        the viewport is where ISSUE-20260823-023 lived. The pane is a slim strip
        until a lesson is opened, and the harness re-asserts the world frame
        with it mounted.
      */}
      <LessonRunner wiring={lessonWiring} />

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
