/**
 * V3 + V4 — the browser robot.
 *
 * Layout is one screen: the 3D scene on the left, everything that explains it
 * on the right. The right-hand column exists because the plan's standing rule
 * for Phase 1 is that the absence of hardware must never be papered over —
 * so every number on screen either says where it came from or says that it
 * cannot be known.
 *
 * Data flow, once:
 *
 * ```text
 * backend (sim in-process | bridge WebSocket)
 *    -> SesameTelemetry
 *    -> TelemetryStore.ingest()      one reduction, provenance preserved
 *    -> useFrame reads store.poseVersion -> Object3D.quaternion   (60 Hz, no React)
 *    -> useStoreTick re-renders the panels                        (~8 Hz)
 * ```
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { OLED_HEIGHT, OLED_WIDTH } from '@sesame-lab/sesame-protocol';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { BridgeBackend, sameOriginBridgeUrl } from './backends/bridge-backend.js';
import { SimBackend } from './backends/sim-backend.js';
import type { BackendId, BackendStatus, TelemetryBackend } from './backends/types.js';
import { installDebugHook } from './debug-hook.js';
import { TelemetryStore } from './state/telemetry-store.js';
import { RobotScene, type SceneHandles } from './three/RobotScene.js';
import type { AssetFacts, JointRig } from './three/rig.js';
import { AssetPanel } from './ui/AssetPanel.js';
import { Controls } from './ui/Controls.js';
import { JointInspector } from './ui/JointInspector.js';
import { OledPanel } from './ui/OledPanel.js';

/**
 * Re-render the panels at a fixed low rate instead of per event.
 *
 * A `runWavePose` produces a servo event every 20 ms plus face frames; letting
 * each one re-render the inspector would burn frames the 3D view needs and
 * would make no visible difference at 8 Hz.
 */
function useStoreTick(store: TelemetryStore, intervalMs = 120): number {
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

export function App(): ReactElement {
  const store = useMemo(() => new TelemetryStore(), []);

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
  const [status, setStatus] = useState<BackendStatus>({
    connection: 'idle',
    detail: 'starting',
    eventsReceived: 0,
  });
  const backendRef = useRef<TelemetryBackend | null>(null);
  const [backend, setBackend] = useState<TelemetryBackend | null>(null);

  const [selected, setSelected] = useState<JointName | null>(null);
  const [showTopCover, setShowTopCover] = useState(true);
  const [driveFromSimulated, setDriveFromSimulated] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handles = useRef<SceneHandles | null>(null);
  const [rig, setRig] = useState<Record<JointName, JointRig> | null>(null);
  const [facts, setFacts] = useState<AssetFacts | null>(null);
  const [groundPlaneMm, setGroundPlaneMm] = useState<number | null>(null);

  const tick = useStoreTick(store);
  void tick;

  // ----------------------------------------------------------- backend swap
  useEffect(() => {
    let disposed = false;
    const next: TelemetryBackend =
      backendId === 'sim' ? new SimBackend() : new BridgeBackend({ url: bridgeUrl });

    // A backend switch is a different robot, not a continuation of the same
    // one. Keeping the previous joint angles would attribute one backend's
    // state to another's provenance.
    store.reset();
    backendRef.current = next;
    setBackend(next);
    setStatus(next.status);
    setError(null);

    const offEvent = next.onEvent((event) => store.ingest(event));
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
  }, [backendId, bridgeUrl, store]);

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
      try {
        await current.command(name);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
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
        rig: () => handles.current?.rig ?? null,
        facts: () => handles.current?.facts ?? null,
        renderStats: () => handles.current?.renderStats() ?? null,
        worldFrame: () => handles.current?.worldFrame() ?? null,
        oledCanvas: () => oledCanvas,
        backendId: () => backendId,
        status: () => backendRef.current?.status ?? status,
        setBackend: async (id, url) => {
          if (url !== undefined) setBridgeUrl(url);
          setBackendId(id);
          // Give the effect a turn of the event loop to tear down and rebuild.
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        run: (command) => runCommand(command),
        setFace: (name) => runFace(name),
        setJoint: (joint, deg) => runSetJoint(joint, deg),
        stop: stopMotion,
        reset: () => store.reset(),
      }),
    [backendId, oledCanvas, runCommand, runFace, runSetJoint, status, stopMotion, store],
  );

  const canDriveFromSimulated = JOINT_ORDER.some((j) => store.joints[j].simulatedDeg !== null);

  return (
    <div className="app">
      <div className="viewport">
        <Suspense fallback={<div className="loading">loading assets/sesame.glb…</div>}>
          <RobotScene
            store={store}
            selected={selected}
            onSelect={setSelected}
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
            provenanceCounts={store.provenanceCounts}
            totalEvents={store.totalEvents}
            busy={busy}
            error={error}
            onCommand={(name) => void runCommand(name)}
            onFace={(name) => void runFace(name)}
            onStop={stopMotion}
          />
        )}

        <JointInspector
          joints={store.joints}
          rig={rig}
          selected={selected}
          onSelect={setSelected}
          canCommand={backend?.canCommand ?? false}
          onSetJoint={(joint, deg) => void runSetJoint(joint, deg)}
        />

        <OledPanel
          panel={store.panel}
          textureCanvas={oledCanvas}
          face={store.face}
          source={store.oledSource}
          emptyFace={store.emptyFace}
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
