/**
 * One reduction of the telemetry stream, shared by the 3D scene, the joint
 * inspector and the OLED.
 *
 * It is a plain observable object rather than React state on purpose. The scene
 * reads joint angles inside `useFrame` and writes them straight onto
 * `THREE.Object3D.quaternion`; routing 60 Hz of servo updates through React
 * would re-render the whole inspector for every 20 ms `motorCurrentDelay` tick
 * and buy nothing. The panels subscribe on a throttle instead.
 *
 * ## What it refuses to do
 *
 * - **It never fills in `measuredDeg`.** The field exists, its type is `null`,
 *   and there is no code path that could set it. `HAS_JOINT_POSITION_FEEDBACK`
 *   is `false`: the stock robot has one-way PWM to eight MG90S servos, no
 *   encoder, no pot tap, no current sense. A UI that draws a "measured" angle
 *   is teaching the learner something false about the hardware.
 * - **It never upgrades provenance.** Whatever the event says is what gets
 *   stored and shown, per joint and in aggregate.
 * - **It never lets `observed` stand in for "measured".** Every event's
 *   `TelemetryOrigin` is kept beside its provenance, because
 *   `provenance: 'observed'` covers three different claims — bytes crossed an
 *   emulated UART, a firmware hook ran, *or* a physical robot moved. The
 *   predicate a UI branches on is `isPhysicallyObserved()`, which is false for
 *   an emulator and false again when no origin was stated at all: unknown is
 *   *not known to be physical*, never physical by default.
 * - **It never invents a first value.** `commandedDeg` starts `null`, meaning
 *   "nothing has been commanded", which is a different statement from "90".
 *   The firmware's `setup()` attaches the servos and deliberately does not move
 *   them, so where a horn actually sits at power-on is genuinely unknown.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import {
  isPhysicallyObserved,
  ORIGIN_KINDS,
  type LogChannel,
  type OriginKind,
  type Provenance,
  type SesameTelemetry,
  type TelemetryOrigin,
  type TelemetryWarning,
} from '@sesame-lab/sesame-protocol';

import { faceFrameCount, renderFace, VirtualOledPanel } from '../oled/framebuffer.js';

/** What the app knows about one joint. Four numbers that are routinely confused. */
export interface JointView {
  readonly joint: JointName;
  /** Last commanded angle, post-subtrim, post-clamp. `null` = never commanded. */
  readonly commandedDeg: number | null;
  /**
   * Where a behaviour model thinks the joint is *right now*, given its slew
   * model. Only a backend that runs a model can answer; `null` otherwise, and
   * `null` is not the same as "at the commanded angle".
   */
  readonly simulatedDeg: number | null;
  /**
   * Always `null`. There is no sensor. See the module comment; the type is
   * `null`, not `number | null`, so no code can assign one by accident.
   */
  readonly measuredDeg: null;
  readonly subtrimDeg: number | null;
  /** Provenance of the event that last set `commandedDeg`. */
  readonly provenance: Provenance | null;
  /**
   * Which boundary that event crossed. `null` = no event yet; an event that
   * stated nothing is stored as `{ kind: 'unknown' }` rather than as `null`,
   * because "nobody said" is itself a fact worth showing.
   */
  readonly origin: TelemetryOrigin | null;
  /**
   * `isPhysicallyObserved()` on that event. **The only field that licenses the
   * word "measured".** False for the simulator, false for QEMU, false for a
   * replay, and false for anything that did not state an origin.
   */
  readonly physicallyObserved: boolean;
  readonly lastSeq: number | null;
  readonly lastTraceId: string | null;
  readonly warnings: readonly TelemetryWarning[];
  readonly updates: number;
}

export interface FaceView {
  readonly name: string;
  readonly frame: number;
  readonly provenance: Provenance;
  readonly origin: TelemetryOrigin | null;
  readonly seq: number;
}

/** Where the pixels currently on the virtual panel came from. */
export interface OledSource {
  /**
   * - `power-on` — GDDRAM is still zeroed; nothing has drawn.
   * - `rendered` — synthesised host-side from a `face.expression` event and the
   *   firmware's own bitmap arrays. The pixels are `inferred`.
   * - `wire` — an `oled.frame` event carried the 1024 bytes. The pixels are
   *   whatever provenance that event declared.
   */
  readonly kind: 'power-on' | 'rendered' | 'wire';
  /** Provenance of the **pixels**, which is not always that of the face event. */
  readonly pixelProvenance: Provenance | null;
  /** Provenance of the event that triggered the draw, when there was one. */
  readonly triggerProvenance: Provenance | null;
  /** Origin of that trigger event, so "which panel is this?" has an answer. */
  readonly triggerOrigin: TelemetryOrigin | null;
  readonly detail: string;
}

/**
 * The last `setFace` that drew nothing, if the panel is currently showing the
 * consequences of the upstream empty-face bug.
 */
export interface EmptyFaceEvent {
  readonly requested: string;
  readonly frame: number;
  readonly provenance: Provenance;
  readonly seq: number;
  readonly reason: string;
}

export interface LogLine {
  readonly seq: number;
  readonly channel: LogChannel;
  readonly text: string;
  readonly provenance: Provenance;
}

const MAX_LOG_LINES = 300;

function blankOriginCounts(): Record<OriginKind, number> {
  return Object.fromEntries(ORIGIN_KINDS.map((k) => [k, 0])) as Record<OriginKind, number>;
}

function blankJoint(joint: JointName): JointView {
  return {
    joint,
    commandedDeg: null,
    simulatedDeg: null,
    measuredDeg: null,
    subtrimDeg: null,
    provenance: null,
    origin: null,
    physicallyObserved: false,
    lastSeq: null,
    lastTraceId: null,
    warnings: [],
    updates: 0,
  };
}

export class TelemetryStore {
  #joints: Record<JointName, JointView> = Object.fromEntries(
    JOINT_ORDER.map((j) => [j, blankJoint(j)]),
  ) as Record<JointName, JointView>;

  #face: FaceView | null = null;
  #emptyFace: EmptyFaceEvent | null = null;
  #panel = new VirtualOledPanel();
  #oledSource: OledSource = {
    kind: 'power-on',
    pixelProvenance: null,
    triggerProvenance: null,
    triggerOrigin: null,
    detail: 'GDDRAM is zeroed. Nothing has called display.display() yet.',
  };
  #provenanceCounts: Record<Provenance, number> = { observed: 0, simulated: 0, inferred: 0 };
  #originCounts: Record<OriginKind, number> = blankOriginCounts();
  #physicallyObservedEvents = 0;
  #lastOrigin: TelemetryOrigin | null = null;
  #typeCounts = new Map<string, number>();
  #log: LogLine[] = [];
  #unknownLines: string[] = [];
  #hello: { protocolVersion: number; emitter: string } | null = null;
  #lastProvenance: Provenance | null = null;
  #totalEvents = 0;
  #version = 0;
  /** Bumped only when something the 3D scene cares about changes. */
  #poseVersion = 0;

  readonly #listeners = new Set<() => void>();

  // ------------------------------------------------------------------ reads

  get joints(): Record<JointName, JointView> {
    return this.#joints;
  }

  get face(): FaceView | null {
    return this.#face;
  }

  get emptyFace(): EmptyFaceEvent | null {
    return this.#emptyFace;
  }

  get panel(): VirtualOledPanel {
    return this.#panel;
  }

  get oledSource(): OledSource {
    return this.#oledSource;
  }

  get provenanceCounts(): Readonly<Record<Provenance, number>> {
    return this.#provenanceCounts;
  }

  get typeCounts(): ReadonlyMap<string, number> {
    return this.#typeCounts;
  }

  get log(): readonly LogLine[] {
    return this.#log;
  }

  get unknownLines(): readonly string[] {
    return this.#unknownLines;
  }

  get hello(): { protocolVersion: number; emitter: string } | null {
    return this.#hello;
  }

  /** Provenance of the most recent event that moved something on screen. */
  get drivingProvenance(): Provenance | null {
    return this.#lastProvenance;
  }

  /**
   * Origin of that same event. Render it with `describeOrigin()` beside the
   * provenance badge; the two answer different questions and only together do
   * they say whether a number on screen is a measurement.
   */
  get drivingOrigin(): TelemetryOrigin | null {
    return this.#lastOrigin;
  }

  /** How many events crossed each kind of boundary. */
  get originCounts(): Readonly<Record<OriginKind, number>> {
    return this.#originCounts;
  }

  /**
   * Events for which `isPhysicallyObserved()` held.
   *
   * Nothing in this project can make this non-zero: there is no physical
   * Sesame. It is counted rather than assumed so that the claim is checkable
   * from the UI and from the headless harness instead of asserted in prose.
   */
  get physicallyObservedEvents(): number {
    return this.#physicallyObservedEvents;
  }

  get totalEvents(): number {
    return this.#totalEvents;
  }

  /** Monotonic; any change at all. */
  get version(): number {
    return this.#version;
  }

  /** Monotonic; only joint angles. The scene polls this instead of subscribing. */
  get poseVersion(): number {
    return this.#poseVersion;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ----------------------------------------------------------------- writes

  /** Wipe everything, including the panel. Used when switching backends. */
  reset(): void {
    this.#joints = Object.fromEntries(JOINT_ORDER.map((j) => [j, blankJoint(j)])) as Record<JointName, JointView>;
    this.#face = null;
    this.#emptyFace = null;
    this.#panel.reset();
    this.#oledSource = {
      kind: 'power-on',
      pixelProvenance: null,
      triggerProvenance: null,
      triggerOrigin: null,
      detail: 'GDDRAM is zeroed. Nothing has called display.display() yet.',
    };
    this.#provenanceCounts = { observed: 0, simulated: 0, inferred: 0 };
    this.#originCounts = blankOriginCounts();
    this.#physicallyObservedEvents = 0;
    this.#lastOrigin = null;
    this.#typeCounts = new Map();
    this.#log = [];
    this.#unknownLines = [];
    this.#hello = null;
    this.#lastProvenance = null;
    this.#totalEvents = 0;
    this.#poseVersion += 1;
    this.#bump();
  }

  ingest(event: SesameTelemetry): void {
    this.#totalEvents += 1;
    this.#provenanceCounts[event.provenance] += 1;
    // An event with no origin counts as `unknown`, not as nothing. Dropping it
    // would make "nobody said where this came from" indistinguishable from "no
    // events arrived", and the first of those is the one a learner must see.
    this.#originCounts[event.origin?.kind ?? 'unknown'] += 1;
    if (isPhysicallyObserved(event)) this.#physicallyObservedEvents += 1;
    this.#typeCounts.set(event.type, (this.#typeCounts.get(event.type) ?? 0) + 1);

    switch (event.type) {
      case 'servo.target':
        this.#onServo(event);
        break;
      case 'face.expression':
        this.#onFace(event);
        break;
      case 'oled.frame':
        this.#onOledFrame(event);
        break;
      case 'log':
        this.#log.push({
          seq: event.seq,
          channel: event.channel,
          text: event.text,
          provenance: event.provenance,
        });
        if (this.#log.length > MAX_LOG_LINES) this.#log = this.#log.slice(-MAX_LOG_LINES);
        break;
      case 'protocol.hello':
        this.#hello = { protocolVersion: event.protocolVersion, emitter: event.emitter };
        break;
      case 'protocol.unknown':
        // Never dropped: the protocol requires the raw line survive, and a
        // learner watching an unsupported verb go past learns more than one
        // looking at a gap.
        this.#unknownLines.push(event.raw);
        if (this.#unknownLines.length > 50) this.#unknownLines = this.#unknownLines.slice(-50);
        break;
    }

    this.#bump();
  }

  /**
   * Record that something asked for a face, before any telemetry comes back.
   *
   * This exists because of the shape of the upstream bug. `setFace("stand")`
   * finds zero frames, never reaches `updateFaceBitmap()`, and therefore emits
   * **no event at all** — so a UI that only listens to telemetry sees nothing
   * happen and has nothing to explain. The silence *is* the symptom, and the
   * only way to surface it is to notice, host-side, that the face the user just
   * asked for has no bitmap.
   *
   * The note is explicitly an inference from the firmware's own bitmap table,
   * not a report of something observed, and it says so.
   */
  noteFaceRequest(name: string): void {
    if (faceFrameCount(name) > 0) return;
    this.#emptyFace = {
      requested: name,
      frame: 0,
      provenance: 'inferred',
      seq: -1,
      reason:
        `setFace("${name}") found zero frames, so the firmware drew nothing AND reported nothing — ` +
        'no face.expression event was emitted at all. epd_bitmap_stand and epd_bitmap_defualt are ' +
        'declared __attribute__((weak)) in firmware/face-bitmaps.h and never defined, so ' +
        'countFrames() returns 0, the fallback table face_defualt_frames is empty too, ' +
        'updateFaceBitmap() is never called, and currentFaceName is quietly rewritten to "default". ' +
        'ISSUE-20260823-004. This note is inferred host-side from the firmware’s own bitmap table; ' +
        'nothing observed it, because there was nothing to observe.',
    };
    this.#bump();
  }

  /**
   * Fold in a backend's model state.
   *
   * Only `simulatedDeg` and `subtrimDeg` are taken. `commandedDeg` stays event-
   * driven so the displayed value is the one that actually crossed the seam,
   * and `measuredDeg` is ignored entirely even though `RobotState` has the
   * field — the store's own type forbids a value there.
   */
  applyModelState(joints: Partial<Record<JointName, { simulatedDeg?: number | undefined; subtrimDeg?: number | undefined }>>): void {
    let changed = false;
    for (const joint of JOINT_ORDER) {
      const incoming = joints[joint];
      if (incoming === undefined) continue;
      const current = this.#joints[joint];
      const simulatedDeg = incoming.simulatedDeg ?? null;
      const subtrimDeg = incoming.subtrimDeg ?? null;
      if (current.simulatedDeg === simulatedDeg && current.subtrimDeg === subtrimDeg) continue;
      this.#joints[joint] = { ...current, simulatedDeg, subtrimDeg };
      changed = true;
    }
    if (changed) this.#bump();
  }

  // --------------------------------------------------------------- handlers

  #onServo(event: Extract<SesameTelemetry, { type: 'servo.target' }>): void {
    const current = this.#joints[event.joint];
    this.#joints[event.joint] = {
      ...current,
      commandedDeg: event.angleDeg,
      provenance: event.provenance,
      origin: event.origin ?? { kind: 'unknown' },
      physicallyObserved: isPhysicallyObserved(event),
      lastSeq: event.seq,
      lastTraceId: event.traceId ?? null,
      warnings: event.warnings ?? [],
      updates: current.updates + 1,
    };
    this.#lastProvenance = event.provenance;
    this.#lastOrigin = event.origin ?? { kind: 'unknown' };
    this.#poseVersion += 1;
  }

  #onFace(event: Extract<SesameTelemetry, { type: 'face.expression' }>): void {
    const frame = event.frame ?? 0;
    this.#face = {
      name: event.name,
      frame,
      provenance: event.provenance,
      origin: event.origin ?? { kind: 'unknown' },
      seq: event.seq,
    };

    const rendered = renderFace(event.name, frame);
    if (rendered === null) {
      // updateFaceBitmap() was never reached. The panel keeps what it had —
      // which is exactly what the glass does — and the UI is told why.
      this.#emptyFace = {
        requested: event.name,
        frame,
        provenance: event.provenance,
        seq: event.seq,
        reason:
          `setFace("${event.name}") found zero frames. epd_bitmap_stand and epd_bitmap_defualt are ` +
          'declared __attribute__((weak)) in firmware/face-bitmaps.h and never defined, so countFrames() ' +
          'returns 0, the fallback table face_defualt_frames is empty too, and updateFaceBitmap() is ' +
          'never called. ISSUE-20260823-004. No pixels are drawn; the panel keeps whatever it held.',
      };
      return;
    }

    this.#emptyFace = null;
    this.#panel.write(rendered.gddram);
    this.#oledSource = {
      kind: 'rendered',
      // The *pixels* were constructed host-side to make a stage visible that no
      // backend transmitted. That is the protocol's definition of `inferred`,
      // and it holds even when the face event itself was observed.
      pixelProvenance: 'inferred',
      triggerProvenance: event.provenance,
      triggerOrigin: event.origin ?? { kind: 'unknown' },
      detail:
        `Rendered host-side: epd_bitmap_${event.name}${frame === 0 ? '' : `_${frame}`} from ` +
        'firmware/face-bitmaps.h, pushed through drawBitmap() into the SSD1306 page-ordered buffer, ' +
        'then through the protocol’s own base64 codec. No backend transmitted these bytes.',
    };
  }

  #onOledFrame(event: Extract<SesameTelemetry, { type: 'oled.frame' }>): void {
    try {
      this.#panel.writeBase64(event.pixels);
    } catch {
      // decodeOledFrame validates the 1024-byte length. A malformed frame is a
      // reportable fact, not a reason to draw something.
      this.#unknownLines.push(`oled.frame seq=${event.seq}: payload did not decode to 1024 bytes`);
      return;
    }
    this.#emptyFace = null;
    this.#oledSource = {
      kind: 'wire',
      pixelProvenance: event.provenance,
      triggerProvenance: event.provenance,
      triggerOrigin: event.origin ?? { kind: 'unknown' },
      detail: 'These 1024 bytes arrived as an oled.frame event. This is what reached the glass.',
    };
  }

  #bump(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}
