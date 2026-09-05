/**
 * Lab mode — the unrestricted surface.
 *
 * Learn mode is guided: every step ends on a check the robot has to satisfy.
 * **This is not a second, unlocked Learn.** There are no steps here, no checks,
 * no progression and no success conditions, and nothing in this file can mark
 * anything complete. The research report's framing is *"an engineering lab with
 * training wheels"* and the training wheels are the honesty labelling — every
 * number says where it came from — not a rail that decides what to build next.
 *
 * ```text
 * Pose      eight sliders, firmware names, the real constrain() order,
 *           the quantised pulse rather than an implied 1 degree
 * Animation Sesame Studio's model kept whole: pose -> frame -> animation,
 *           played on the robot, exported as setServoAngle() C++
 * Face      128x64, drawn, pushed through drawBitmap(), exported as a
 *           face-bitmaps.h array
 * API       free-form requests against whatever is actually serving this page
 * Faults    the seven declared ones, sorted by who caused them
 * ```
 *
 * Five composition decisions worth stating, because the alternative was
 * available in each case and is worse:
 *
 * **1. Every editor here is L6's, not a Lab copy.** `SequenceEditor`,
 * `PixelEditor`, `SubtrimControl`, `FaultInjector`, `HttpConsole` and
 * `PwmInspector` live in `src/editors/` and import nothing from `src/lessons/`,
 * precisely so that this file can compose them. Two implementations of the
 * pixel editor would eventually disagree about what a face bitmap is.
 *
 * **2. The pixel editor's coordinate API is used the way it has to be.**
 * `PixelEditor` hands back `(x, y, on)` rather than a whole frame, because a
 * drag delivers several `pointermove` events before React re-renders and a
 * parent computing `next` from `props.frame` reads the same stale buffer every
 * time. So the frame is held in its own `useState` and every stroke is a
 * **functional** update — `setFace((previous) => setPixel(previous, x, y, on))`.
 * In Learn a step toggles one pixel and the bug is invisible; in a Lab people
 * drag, and the harness drags a nine-pixel square to prove all nine survive.
 *
 * **3. `setServoAngle()` per channel stays visible.** The firmware has no
 * multi-joint primitive: `runStandPose()` is eight consecutive calls in enum
 * order. "Send all eight" is therefore labelled as eight calls and the export
 * emits eight lines. Wrapping that in a `setPose()` abstraction would be a
 * nicer API and a false one — the aliasing, the per-channel subtrim and the
 * `motorCurrentDelay` stagger all live in the fact that it is eight writes.
 *
 * **4. The face frame is stored, the OLED buffer is not.** What the editor
 * holds is the row-major MSB-first layout `face-bitmaps.h` uses; the panel
 * holds page-ordered GDDRAM; `renderAuthoredBitmap()` is the conversion and it
 * is the same one `drawBitmap()` performs on the robot. Both are shown, because
 * the difference between them is half of what makes the OLED interesting.
 *
 * **5. The C++ export is the one artefact that can leave this system.**
 * It carries its warning in the generated code itself, not only in the UI, so
 * the warning survives the clipboard.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { FaultInjector } from '../editors/FaultInjector.js';
import { HttpConsole } from '../editors/HttpConsole.js';
import { LabModifications } from '../editors/LabModifications.js';
import { PixelEditor } from '../editors/PixelEditor.js';
import { PwmInspector } from '../editors/PwmInspector.js';
import { SequenceEditor } from '../editors/SequenceEditor.js';
import { SubtrimControl } from '../editors/SubtrimControl.js';
import {
  blankFrame,
  changedPixels,
  countLitPixels,
  densestWindow,
  setPixel,
} from '../editors/pixel-frame.js';
import { importMovement, outOfRangeAngles, type SequenceDoc } from '../editors/sequence.js';
import { ARCH_NODES } from '../generated/architecture-graph.js';
import { PoseControl } from './PoseControl.js';
import {
  aliasingInExport,
  cppIdentifier,
  emitSesameCpp,
  roundTrip,
  studioRangeViolations,
  type DelayStyle,
} from './cpp-export.js';
import { FACE_HEADER_LAYOUT_NOTE, emitFaceHeader, faceHeaderRoundTrip } from './face-header.js';
import {
  clearProject,
  decodeFace,
  emptyProject,
  encodeFace,
  frameAsPose,
  loadProject,
  neutralPose,
  poseAsFrame,
  projectIsEmpty,
  saveProject,
  type LabProject,
  type Pose,
} from './lab-doc.js';
import type { LabWiring } from './lab-wiring.js';

type LabTab = 'pose' | 'animation' | 'face' | 'api' | 'faults';

const TABS: readonly { readonly id: LabTab; readonly label: string }[] = [
  { id: 'pose', label: 'Pose' },
  { id: 'animation', label: 'Animation' },
  { id: 'face', label: 'Face' },
  { id: 'api', label: 'API' },
  { id: 'faults', label: 'Faults' },
];

/**
 * The routes the firmware actually registers, read out of the generated graph.
 *
 * Ten of them, not the five a lesson step ever names, and derived from
 * `hardware/hardware-map.json` → `network.http.routes` rather than typed here,
 * so the list cannot drift from the map. The catch-all `*` is dropped: it is a
 * real registration and not a request anyone can send.
 */
const FIRMWARE_ROUTES: readonly string[] = ARCH_NODES.filter(
  (node) => node.kind === 'route' && node.label !== 'ANY *',
).map((node) => node.label.replace(/^ANY\s+/, ''));

/** Autosave debounce. Long enough that typing an angle is one write, not four. */
const SAVE_DEBOUNCE_MS = 400;

export function LabMode(props: { readonly wiring: LabWiring }): ReactElement {
  const { wiring } = props;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<LabTab>('pose');

  /**
   * Re-render when LAB-side state changes, coalesced, and only while open.
   *
   * Two facts force this shape.
   *
   * `App` re-renders on the telemetry store, and injecting a fault or moving
   * subtrim emits no telemetry whatsoever — so without a subscription the
   * "Sesame Robot Emulator is modifying this robot" banner would keep saying nothing is
   * modified until the next servo event happened to arrive, i.e. it would only
   * be right while the robot was busy.
   *
   * But the runtime bumps on **every** telemetry event, which during a
   * movement is ~50 Hz, and re-rendering a pane that holds a pose table and
   * two export boxes at 50 Hz comes straight out of the 3D view's frame
   * budget under SwiftShader. Measured: it was enough to starve the 200 ms
   * `visual.joint` sampler that puts the last rung on the causal trace. So the
   * subscription sets a flag and a 200 ms timer does the re-render — the same
   * shape `useStoreTick` uses in `App` — and neither runs at all while the
   * pane is a closed strip, which renders nothing that depends on it.
   */
  const [, setRuntimeTick] = useState(0);
  const runtimeDirty = useRef(false);
  const subscribe = wiring.subscribe;
  useEffect(() => {
    if (!open) return undefined;
    const off = subscribe(() => {
      runtimeDirty.current = true;
    });
    const id = setInterval(() => {
      if (!runtimeDirty.current) return;
      runtimeDirty.current = false;
      setRuntimeTick((t) => t + 1);
    }, 200);
    return () => {
      off();
      clearInterval(id);
    };
  }, [subscribe, open]);

  // ------------------------------------------------------------ the project
  //
  // Loaded once, defensively: a blocked accessor, an absent value and somebody
  // else's JSON all produce an empty project and none is an error a learner
  // has to see. See `lab-doc.ts`.
  const [project, setProject] = useState<LabProject>(() => loadProject());
  /**
   * The face frame, held OUTSIDE the project object.
   *
   * Not a style choice. `PixelEditor.onPaint` hands back one coordinate at a
   * time and a drag delivers several before React re-renders; the only update
   * that keeps a fast stroke intact is a functional one against the previous
   * buffer, and doing that through a base64 field inside a larger object would
   * mean decoding 1024 bytes per `pointermove` for no gain. The base64 is
   * written back into the project on save.
   */
  const [face, setFace] = useState<Uint8Array>(() => decodeFace(project.faceBase64));
  const [savedAt, setSavedAt] = useState<number | null>(project.savedAt === 0 ? null : project.savedAt);
  const [storageBlocked, setStorageBlocked] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      const next = { ...project, faceBase64: encodeFace(face) };
      saveProject(next);
      // Read it straight back. `saveProject` swallows a quota or private-window
      // failure by design, and a "saved" badge that lies about it would be
      // worse than no badge: the reload the learner is counting on is the one
      // that would come back empty.
      let confirmed = false;
      try {
        confirmed = (globalThis.localStorage?.getItem('sesame-lab.lab.v1') ?? null) !== null;
      } catch {
        confirmed = false;
      }
      setStorageBlocked(!confirmed);
      setSavedAt(confirmed ? Date.now() : null);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [project, face]);

  const pose = project.pose;
  const doc = project.animation;

  const setPose = useCallback((joint: JointName, deg: number): void => {
    setProject((previous) => ({ ...previous, pose: { ...previous.pose, [joint]: deg } }));
  }, []);

  const setDoc = useCallback((next: SequenceDoc): void => {
    setProject((previous) => ({ ...previous, animation: next }));
  }, []);

  // ------------------------------------------------------------------ pose
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  const sendJoint = useCallback(
    (joint: JointName): void => {
      void wiring.setJoint(joint, pose[joint]);
    },
    [wiring, pose],
  );

  /**
   * Eight `setServoAngle()` calls in firmware enum order, awaited in sequence.
   *
   * Not `Promise.all`. The firmware issues them one at a time and each one is
   * followed by `delayWithFace(motorCurrentDelay)`; firing eight concurrently
   * would be a shape the robot does not have, and on the QEMU backend it would
   * race eight HTTP requests at a single-threaded server.
   */
  const sendPose = useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      for (const joint of JOINT_ORDER) await wiring.setJoint(joint, pose[joint]);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [wiring, pose]);

  const capturePose = useCallback((): void => {
    setProject((previous) => ({
      ...previous,
      animation: {
        ...previous.animation,
        frames: [...previous.animation.frames, poseAsFrame(previous.pose, 300)],
      },
    }));
    setTab('animation');
  }, []);

  const loadFrameIntoPose = useCallback((index: number): void => {
    setProject((previous) => {
      const frame = previous.animation.frames[index];
      if (frame === undefined) return previous;
      return { ...previous, pose: frameAsPose(frame, previous.pose) as Pose };
    });
    setTab('pose');
  }, []);

  // ------------------------------------------------------------- animation
  const runDoc = useCallback(
    async (changedField: string | null): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      try {
        await wiring.runSequence(doc, changedField);
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [wiring, doc],
  );

  const onImport = useCallback((movementFunction: string): void => {
    const imported = importMovement(movementFunction);
    if (imported === null) return;
    setProject((previous) => ({ ...previous, animation: imported.doc, cppFunctionName: imported.doc.name }));
  }, []);

  // ------------------------------------------------------------------ face
  const paint = useCallback((x: number, y: number, on: boolean): void => {
    // Functional. See the note on `face` above — this is the whole fix for the
    // dropped-pixel drag, and a `setFace(setPixel(face, x, y, on))` here would
    // reintroduce it silently.
    setFace((previous) => setPixel(previous, x, y, on));
  }, []);

  const pushFace = useCallback((): void => {
    wiring.pushPixelFrame(face);
  }, [wiring, face]);

  const litPixels = useMemo(() => countLitPixels(face), [face]);
  const densest = useMemo(() => (litPixels === 0 ? null : densestWindow(face, 5, 5)), [face, litPixels]);
  /**
   * The last saved face, decoded once per change rather than once per render.
   *
   * Both readouts that use it — the closed strip's summary and the "N pixels
   * differ from the last saved copy" line — otherwise base64-decode 1024 bytes
   * and walk them on every re-render, which at the runtime's event rate is a
   * measurable slice of the renderer's budget.
   */
  const savedFace = useMemo(() => decodeFace(project.faceBase64), [project.faceBase64]);
  const savedLitPixels = useMemo(() => countLitPixels(savedFace), [savedFace]);
  const unsavedPixels = useMemo(() => changedPixels(face, savedFace), [face, savedFace]);

  // ---------------------------------------------------------- the exports
  const cppSource = useMemo(
    () => emitSesameCpp(doc, { functionName: project.cppFunctionName, delayStyle: project.delayStyle }),
    [doc, project.cppFunctionName, project.delayStyle],
  );
  const cppRoundTrip = useMemo(
    () => roundTrip(doc, { functionName: project.cppFunctionName, delayStyle: project.delayStyle }),
    [doc, project.cppFunctionName, project.delayStyle],
  );
  const aliasing = useMemo(() => aliasingInExport(doc), [doc]);
  const studioViolations = useMemo(() => studioRangeViolations(doc), [doc]);
  const outOfRange = useMemo(() => outOfRangeAngles(doc), [doc]);

  const faceSource = useMemo(() => emitFaceHeader(face, project.faceName), [face, project.faceName]);
  const faceRoundTrip = useMemo(() => faceHeaderRoundTrip(face, project.faceName), [face, project.faceName]);

  // ------------------------------------------------------------- rendering
  if (!open) {
    return (
      <section className="lab-panel" data-testid="lab-panel" data-open="false">
        <div className="panel-header">
          <h2 className="panel-title-echo">Lab</h2>
          <span className="panel-sub">
            No steps, no checks, nothing to complete &mdash; the robot, the eight channels, the
            panel and the routes, to do what you like with.
          </span>
          <button type="button" className="lesson-button is-primary" data-testid="lab-open" onClick={() => setOpen(true)}>
            open the lab
          </button>
        </div>
        <p className="note muted small" data-testid="lab-restored">
          {projectIsEmpty(project) && savedAt === null
            ? 'Nothing saved yet. Whatever you build here is kept in this browser and reloads with the page.'
            : `A saved project is waiting: ${String(project.animation.frames.length)} frame(s), ${String(savedLitPixels)} lit pixel(s).`}
        </p>
      </section>
    );
  }

  return (
    <section className="lab-panel is-open" data-testid="lab-panel" data-open="true" data-tab={tab}>
      <div className="panel-header">
        <h2 className="panel-title-echo">Lab</h2>
        <input
          className="lab-name"
          type="text"
          value={project.name}
          data-testid="lab-name"
          aria-label="project name"
          onChange={(e) => setProject((previous) => ({ ...previous, name: e.target.value }))}
        />
        <span className="panel-sub" data-testid="lab-saved" data-blocked={String(storageBlocked)}>
          {storageBlocked
            ? 'not saved — this browser is refusing to store site data. Everything here is lost on reload.'
            : savedAt === null
              ? 'not saved yet'
              : `saved in this browser · ${new Date(savedAt).toLocaleTimeString()}`}
        </span>
        <button
          type="button"
          className="linkish"
          data-testid="lab-forget"
          onClick={() => {
            clearProject();
            const fresh = emptyProject();
            setProject(fresh);
            setFace(blankFrame());
            setSavedAt(null);
          }}
        >
          forget this project
        </button>
        <button type="button" className="linkish" data-testid="lab-close" onClick={() => setOpen(false)}>
          close
        </button>
      </div>

      <LabModifications
        subtrimDeg={wiring.subtrimDeg}
        faults={[...wiring.faults]}
        panelAuthored={wiring.panelAuthored}
        onClear={() => wiring.clearLabModifications()}
      />

      <div className="lab-tabs" data-testid="lab-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'lab-tab is-active' : 'lab-tab'}
            data-testid={`lab-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="lab-body">
        {tab === 'pose' && (
          <>
            <PoseControl
              pose={pose}
              onChange={setPose}
              subtrimDeg={wiring.subtrimDeg}
              reported={wiring.commandedDeg}
              onSend={sendJoint}
              onSendAll={() => void sendPose()}
              onCapture={capturePose}
              busy={running || wiring.busy !== null}
            />
            <details className="lab-details" data-testid="lab-subtrim-details">
              <summary>subtrim &mdash; the offset the firmware adds before it clamps</summary>
              <SubtrimControl
                value={wiring.subtrimDeg}
                onChange={wiring.setSubtrim}
                disabled={!wiring.canSetSubtrim}
              />
              {!wiring.canSetSubtrim && (
                <p className="note muted small" data-testid="lab-subtrim-unreachable">
                  This backend has no lab-reachable subtrim. The sliders are disabled rather than
                  moving and doing nothing.
                </p>
              )}
            </details>
            <details className="lab-details" data-testid="lab-pwm-details">
              <summary>what one angle does to the pin</summary>
              <PwmInspector angleDeg={pose.R1} onAngle={(deg) => setPose('R1', deg)} probed={[]} onSweep={() => undefined} sweepRuns={0} />
            </details>
          </>
        )}

        {tab === 'animation' && (
          <>
            <p className="note muted small" data-testid="lab-studio-note">
              Sesame Studio&rsquo;s model, kept whole: a <b>pose</b> is eight angles, a{' '}
              <b>frame</b> is a pose plus a wait, an <b>animation</b> is ordered frames. What is
              different is that this one drives the robot instead of only printing code, and the
              code it prints is checked by reading it back.
            </p>
            <SequenceEditor
              doc={doc}
              onChange={setDoc}
              onImport={onImport}
              onRun={(changedField) => void runDoc(changedField)}
              running={running || wiring.busy !== null}
            />
            {doc.frames.length > 0 && (
              <div className="editor-row" data-testid="lab-frame-loaders">
                <span className="muted small">load a frame into the sliders:</span>
                {doc.frames.map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    className="linkish"
                    data-testid={`lab-load-frame-${String(index)}`}
                    onClick={() => loadFrameIntoPose(index)}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            )}

            <div className="lab-export" data-testid="lab-cpp-export">
              <h4>Export &mdash; Sesame-compatible C++</h4>
              <p className="lesson-lab-note is-inferred" data-testid="lab-cpp-warning">
                <b>This is the one thing here that can leave this system and touch a real robot.</b>{' '}
                These are <b>commanded</b> angles. Nothing in Sesame Robot Emulator has ever driven physical
                hardware, so none of these numbers has been verified against a servo; the firmware
                has no position feedback to verify them with. And <b>89 of the 181 commandable
                angles are indistinguishable at the pin</b> &mdash; 181 commands, 92 distinct
                pulses &mdash; so neighbouring values below may be the same instruction.
              </p>
              <div className="editor-row">
                <label className="muted small">
                  function&nbsp;
                  <input
                    className="mono"
                    type="text"
                    value={project.cppFunctionName}
                    data-testid="lab-cpp-name"
                    onChange={(e) => setProject((previous) => ({ ...previous, cppFunctionName: e.target.value }))}
                  />
                </label>
                <span className="mono muted small" data-testid="lab-cpp-identifier">
                  &rarr; void {cppIdentifier(project.cppFunctionName)}()
                </span>
                <select
                  className="lesson-select"
                  data-testid="lab-cpp-delay-style"
                  value={project.delayStyle}
                  onChange={(e) =>
                    setProject((previous) => ({ ...previous, delayStyle: e.target.value as DelayStyle }))
                  }
                >
                  <option value="delayWithFace">delayWithFace() — what the firmware uses</option>
                  <option value="delay">delay() — what Sesame Studio emits</option>
                </select>
              </div>
              {project.delayStyle === 'delay' && (
                <p className="note is-fail small" data-testid="lab-cpp-delay-warning">
                  <code>delay()</code> is what Studio generates, and it blocks. The firmware&rsquo;s
                  own movement bodies call <code>delayWithFace()</code>, which spins for the same
                  duration while servicing <code>updateAnimatedFace()</code>,{' '}
                  <code>server.handleClient()</code> and <code>dnsServer.processNextRequest()</code>.
                  Pasting <code>delay()</code> in freezes the face, the web server and the captive
                  portal for its whole duration.
                </p>
              )}
              <textarea
                className="mono lab-code"
                rows={10}
                readOnly
                value={cppSource}
                data-testid="lab-cpp-source"
              />
              <p
                className={cppRoundTrip.ok ? 'note is-pass small' : 'note is-fail small'}
                data-testid="lab-cpp-roundtrip"
                data-ok={String(cppRoundTrip.ok)}
                data-writes={String(cppRoundTrip.writes.length)}
              >
                <b>Read back:</b> {cppRoundTrip.detail}. The emitted text is parsed again by the
                same rule the firmware&rsquo;s own bodies are read under &mdash; writes accumulate,
                a wait closes the frame &mdash; and the pose sequence is compared. An export nobody
                reads back is an export nobody has checked.
              </p>
              <p className="note muted small" data-testid="lab-cpp-shape">
                Call shape: <code>setServoAngle(R1, 135);</code> &mdash;{' '}
                <code>firmware/movement-sequences.h:80</code>, with <code>R1</code> the{' '}
                <code>enum ServoName</code> constant declared at <code>:5</code>, matching{' '}
                <code>void setServoAngle(uint8_t channel, int angle)</code> in{' '}
                <code>hardware/hardware-map.json</code>. Sesame Studio emits the same call.
              </p>
              {outOfRange.length > 0 && (
                <p className="note is-fail small" data-testid="lab-cpp-out-of-range">
                  {outOfRange.length} angle(s) are outside 0&ndash;180. The firmware will clamp them
                  and say nothing; the export writes what you typed.
                </p>
              )}
              {studioViolations.length > 0 && (
                <p className="note muted small" data-testid="lab-cpp-studio-range">
                  Sesame Studio would have refused {studioViolations.length} of these
                  (it caps R1/L2 at 45&ndash;180 and R2/L1 at 0&ndash;135). The firmware does not:{' '}
                  <code>setServoAngle()</code> clamps to 0&ndash;180 and nothing else. Studio&rsquo;s
                  narrower limits are somebody&rsquo;s belief about the linkage, not a rule the code
                  enforces.
                </p>
              )}
              {aliasing.length > 0 && (
                <p className="note muted small" data-testid="lab-cpp-aliasing">
                  {aliasing.length} distinct angle(s) in this export share a pulse with a
                  neighbour, e.g. {aliasing[0]?.angleDeg}&deg; = {aliasing[0]?.aliases.join(', ')}
                  &deg; (LEDC tick {aliasing[0]?.ticks}).
                </p>
              )}
            </div>
          </>
        )}

        {tab === 'face' && (
          <>
            <PixelEditor
              frame={face}
              onPaint={paint}
              onClear={() => setFace(blankFrame())}
              onPush={pushFace}
              changed={litPixels}
              densest={densest}
            />
            <p className="note muted small" data-testid="lab-face-diff">
              {unsavedPixels} pixel(s) differ from the last saved copy.
            </p>
            <div className="lab-export" data-testid="lab-face-export">
              <h4>Export &mdash; a <code>face-bitmaps.h</code> array</h4>
              <div className="editor-row">
                <label className="muted small">
                  name&nbsp;
                  <input
                    className="mono"
                    type="text"
                    value={project.faceName}
                    data-testid="lab-face-name"
                    onChange={(e) => setProject((previous) => ({ ...previous, faceName: e.target.value }))}
                  />
                </label>
                <button
                  type="button"
                  className="lesson-button is-primary"
                  data-testid="lab-face-push"
                  onClick={pushFace}
                >
                  push to the panel
                </button>
              </div>
              <textarea
                className="mono lab-code"
                rows={8}
                readOnly
                value={faceSource}
                data-testid="lab-face-source"
              />
              <p
                className={faceRoundTrip.ok ? 'note is-pass small' : 'note is-fail small'}
                data-testid="lab-face-roundtrip"
                data-ok={String(faceRoundTrip.ok)}
              >
                <b>Read back:</b> {faceRoundTrip.detail}.
              </p>
              <p className="note muted small" data-testid="lab-face-layout">
                {FACE_HEADER_LAYOUT_NOTE}
              </p>
            </div>
          </>
        )}

        {tab === 'api' && (
          <HttpConsole
            onSend={(method, route, body) => void wiring.sendHttp(method, route, body)}
            exchanges={wiring.httpExchanges}
            defaultRoute={project.httpRoute}
            defaultMethod={project.httpMethod}
            defaultBody={project.httpBody}
            routes={FIRMWARE_ROUTES}
            freeForm
            busy={wiring.busy !== null}
            onDraftChange={(method, route, body) =>
              setProject((previous) => ({ ...previous, httpMethod: method, httpRoute: route, httpBody: body }))
            }
            note={
              <div data-testid="lab-api-notes">
                <p className="note muted small" data-testid="lab-api-any">
                  All ten routes are registered with the two-argument{' '}
                  <code>WebServer::on(uri, handler)</code> overload, which binds{' '}
                  <b>HTTP_ANY</b>. Method restrictions exist only inside handlers:{' '}
                  <code>/api/command</code> and <code>/api/wifi/connect</code> answer 405 for
                  non-POST, and nothing else checks at all. The GET-only documentation in{' '}
                  <code>firmware/README.md</code> is not enforced by the server &mdash; so{' '}
                  <code>DELETE /getSettings</code> works, and finding that out is the point of a
                  console you can type into.
                </p>
                <p className="note muted small" data-testid="lab-api-issue-021">
                  <code>handleGetStatus()</code> builds its JSON by string concatenation and does
                  not escape <code>currentCommand</code> or <code>currentFaceName</code>, while
                  upstream <i>does</i> escape SSIDs with <code>jsonEscape()</code> twenty lines
                  away. Store a command word containing a quotation mark and{' '}
                  <code>/api/status</code> returns syntactically invalid JSON. That is
                  ISSUE-20260823-021, it is real, and poking at it here is a feature.
                  <b>
                    {' '}
                    What you are talking to is not that code.
                  </b>{' '}
                  Sesame Robot Emulator&rsquo;s own adapter reduces every name to{' '}
                  <code>[A-Za-z0-9_.-]</code> at the boundary, with no way to switch it off,
                  because emitting attacker-controlled JSON or a forged telemetry sentinel is not a
                  compatibility feature. The defect is described here and not reproduced here.
                </p>
              </div>
            }
          />
        )}

        {tab === 'faults' && (
          <FaultInjector
            active={wiring.faults}
            onToggle={wiring.setFault}
            onSelectSymbol={wiring.selectSymbol}
            onBoot={wiring.runBoot}
            bootLog={wiring.bootLog}
            bootHaltedAt={wiring.bootHaltedAt}
          />
        )}
      </div>

      <p className="note muted small" data-testid="lab-honesty">
        Nothing on this page claims a servo moved. There is no physical robot in this project,{' '}
        <code>isPhysicallyObserved()</code> is false for every event, and the pose readouts are
        commanded angles that the firmware itself has no way to verify.
      </p>
    </section>
  );
}

/** Exported for the unit tests: the neutral pose the Lab opens on. */
export { neutralPose };
