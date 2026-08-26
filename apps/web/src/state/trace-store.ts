/**
 * "See the Signal" — one user action, followed down every layer, with an honest
 * label on each row.
 *
 * The research report asks for this ladder:
 *
 * ```text
 * ui.command        Wave
 * http.request      POST /api/command
 * firmware.command  wave
 * movement.enter    runWavePose
 * servo.target      L3=180
 * pwm.output        channel=6 pulse=...
 * joint.target      L3=180
 * visual.joint      L3=...
 * ```
 *
 * and it asks the UI to distinguish `OBSERVED FROM EMULATOR` / `SIMULATED` /
 * `INFERRED FOR EXPLANATION`. A causal trace is exactly where a learner will
 * over-trust, so every row below carries three things and the UI shows all
 * three: a {@link Provenance}, a {@link TelemetryOrigin}, and a **witness** —
 * one clause naming who says so.
 *
 * ## The row that matters most: `pwm.output`
 *
 * It is `inferred`, permanently, on every backend, and the app never prints a
 * channel number.
 *
 * - Q3 read the LEDC register file back over QEMU's gdbstub: the registers hold
 *   correct values and the model produces **no pulse, no edge and no waveform**.
 *   So there is nothing to observe under the emulator even in principle.
 * - There is no physical robot and there never will be, so
 *   `isPhysicallyObserved()` is false for everything this system will ever
 *   produce. This row can therefore never be upgraded.
 * - The pulse figure shown is real arithmetic, not a placeholder:
 *   `quantiseCommandedAngle()` reproduces ESP32Servo 3.0.9's own
 *   `map()` → `usToTicks()` chain, including the 2500 µs clamp the firmware's
 *   `attach(pin, 732, 2929)` never sees. That is where "the code said 135°" and
 *   "a servo would have gone there" visibly separate: 89 of the 181 commandable
 *   angles produce a pulse identical to a neighbour's.
 *
 * ## Correlation, and saying which kind you got
 *
 * `traceId` threads end to end through `@sesame-lab/sesame-sim`, so on the
 * simulator every adopted event carries the id this store handed out and the
 * link is causal. **The firmware has no trace-id field** — nothing can carry an
 * id across UART0 into the guest — so on QEMU rows are adopted by arrival
 * window instead. That is correlation, not causation, and each row says which
 * one it is via {@link TraceRow.match}. A trace panel that hid the difference
 * would be teaching the learner to trust a join it cannot make.
 */
import { quantiseCommandedAngle } from '@sesame-lab/sesame-model';
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import {
  isPhysicallyObserved,
  type Provenance,
  type SesameTelemetry,
  type TelemetryOrigin,
} from '@sesame-lab/sesame-protocol';

import type { BackendId } from '../backends/types.js';
import {
  ACTIVE_BOARD_ID,
  ARCH_NODE_BY_ID,
  COMMAND_TRACE_BY_NAME,
  HTTP_COMMAND_ROUTE,
  JOINT_FACTS,
  ORIGIN_BOARD_ALIASES,
  PWM_FACTS,
  SERVO_PINS_BY_BOARD,
  SET_SERVO_ANGLE_FACTS,
  type ArchSourceRef,
  type CommandTraceFacts,
} from '../generated/architecture-graph.js';

/** The causal ladder, in causal order. The index IS the rank. */
export const TRACE_LAYERS = [
  'ui.command',
  'http.request',
  'firmware.command',
  'movement.enter',
  'servo.target',
  'pwm.output',
  'joint.target',
  'visual.joint',
] as const;

export type TraceLayer = (typeof TRACE_LAYERS)[number];

export const LAYER_RANK: Readonly<Record<TraceLayer, number>> = Object.freeze(
  Object.fromEntries(TRACE_LAYERS.map((l, i) => [l, i])) as Record<TraceLayer, number>,
);

/** One line each, for the layer legend. */
export const LAYER_MEANING: Readonly<Record<TraceLayer, string>> = Object.freeze({
  'ui.command': 'You pressed a button in this page.',
  'http.request': 'The robot’s own HTTP route — whether or not one was actually sent.',
  'firmware.command': 'The command word the firmware would dispatch, and the function it names.',
  'movement.enter': 'The movement function starting, as announced by its own Serial banner.',
  'servo.target': 'setServoAngle() reached a channel with an angle.',
  'pwm.output': 'What that angle becomes at the pin — computed here, never observed.',
  'joint.target': 'The mechanical joint that servo channel drives.',
  'visual.joint': 'What the 3D scene is actually showing, read back off the scene graph.',
});

/**
 * How a row got attached to this trace.
 *
 * - `app-local` — the row was created by this app, not adopted from a stream.
 * - `trace-id` — the event carried the trace id this store issued. Causal.
 * - `time-window` — the event arrived inside the trace's window with no id.
 *   Correlation only. The firmware cannot carry a trace id.
 */
export type RowMatch = 'app-local' | 'trace-id' | 'time-window';

export interface TraceRow {
  readonly id: string;
  readonly layer: TraceLayer;
  readonly rank: number;
  /** The short form, e.g. `L3=180`. */
  readonly label: string;
  /** The long form: what actually happened, in one sentence. */
  readonly detail: string;
  readonly provenance: Provenance;
  readonly origin: TelemetryOrigin | null;
  /** `isPhysicallyObserved()` on this row. False forever; counted, not assumed. */
  readonly physicallyObserved: boolean;
  /** Who says so. Always rendered — a badge alone is not an explanation. */
  readonly witness: string;
  readonly match: RowMatch;
  readonly joint: JointName | null;
  /** The architecture node this row belongs to. Drives cross-highlighting. */
  readonly nodeId: string | null;
  readonly sourceRef: ArchSourceRef | null;
  /** Milliseconds since the trace opened. */
  readonly tMs: number;
  readonly seq: number | null;
  /** How many times this row was rewritten (a wave writes L3 twice). */
  readonly updates: number;
}

export interface Trace {
  readonly id: string;
  readonly command: string;
  readonly backendId: BackendId;
  readonly startedAt: number;
  readonly facts: CommandTraceFacts | null;
  readonly rows: readonly TraceRow[];
  /** True once any adopted event carried this trace's id. */
  readonly carriedTraceId: boolean;
  /** Events that arrived in the window with no trace id at all. */
  readonly windowAdopted: number;
}

/**
 * How long after the click an id-less event may still be adopted.
 *
 * `runBowPose` is the longest movement in the extracted choreography and a
 * continuous command (`forward`) never ends at all, so this is a display
 * window, not a claim about when the robot stopped.
 */
const ADOPTION_WINDOW_MS = 20000;

/** Keep a short history so a learner can compare two commands. */
const MAX_TRACES = 6;

function rowKey(layer: TraceLayer, joint: JointName | null): string {
  return joint === null ? layer : `${layer}:${joint}`;
}

/** Which board's pin table applies, given whatever the origin declared. */
function boardFor(origin: TelemetryOrigin | null): string {
  const declared = origin?.board;
  if (declared === undefined) return ACTIVE_BOARD_ID;
  return ORIGIN_BOARD_ALIASES[declared] ?? (declared in SERVO_PINS_BY_BOARD ? declared : ACTIVE_BOARD_ID);
}

interface MutableTrace {
  id: string;
  command: string;
  backendId: BackendId;
  startedAt: number;
  facts: CommandTraceFacts | null;
  rows: Map<string, TraceRow>;
  carriedTraceId: boolean;
  windowAdopted: number;
}

export class TraceStore {
  #traces: MutableTrace[] = [];
  #version = 0;
  readonly #listeners = new Set<() => void>();
  #counter = 0;

  get version(): number {
    return this.#version;
  }

  /** Newest first. */
  get traces(): readonly Trace[] {
    return this.#traces.map(freeze);
  }

  get active(): Trace | null {
    const t = this.#traces[0];
    return t === undefined ? null : freeze(t);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    this.#traces = [];
    this.#bump();
  }

  /**
   * Mint a trace id for a command the UI is about to send.
   *
   * The id is handed to the backend so `@sesame-lab/sesame-sim` can stamp it on
   * every event it emits. The QEMU backend takes it and cannot use it, which is
   * itself the fact `RowMatch` reports.
   */
  mintTraceId(command: string): string {
    this.#counter += 1;
    return `${command}-${String(this.#counter).padStart(4, '0')}`;
  }

  /**
   * Open a trace and lay down the rows this app can honestly claim before any
   * telemetry arrives: the click, the route, and the command→function mapping.
   */
  open(input: {
    readonly traceId: string;
    readonly command: string;
    readonly backendId: BackendId;
    /** Non-null when the backend is an emulator; used to qualify the HTTP row. */
    readonly emulatorOrigin: TelemetryOrigin | null;
    /** Whether this backend really issues the firmware's HTTP route. */
    readonly usesHttpRoute: boolean;
  }): void {
    const now = performance.now();
    const facts = COMMAND_TRACE_BY_NAME.get(input.command) ?? null;
    const trace: MutableTrace = {
      id: input.traceId,
      command: input.command,
      backendId: input.backendId,
      startedAt: now,
      facts,
      rows: new Map(),
      carriedTraceId: false,
      windowAdopted: 0,
    };
    this.#traces.unshift(trace);
    if (this.#traces.length > MAX_TRACES) this.#traces.length = MAX_TRACES;

    // ------------------------------------------------------------ ui.command
    //
    // A real event, in this browser, witnessed by this app's own click handler.
    // `origin` stays null: none of the five origin kinds describes a DOM event,
    // and inventing a sixth would put a browser on the same axis as a robot.
    this.#put(trace, {
      layer: 'ui.command',
      label: input.command,
      detail: `A button in this page dispatched the command word "${input.command}".`,
      provenance: 'observed',
      origin: null,
      witness:
        'This page’s own click handler. Real, and about the browser — not about the robot, ' +
        'which is why no origin is claimed.',
      match: 'app-local',
      joint: null,
      nodeId: null,
      sourceRef: null,
      seq: null,
    });

    // ---------------------------------------------------------- http.request
    const route = `${HTTP_COMMAND_ROUTE.enforcedMethod ?? HTTP_COMMAND_ROUTE.registeredMethod} ${HTTP_COMMAND_ROUTE.path}`;
    this.#put(trace, {
      layer: 'http.request',
      label: route,
      detail: input.usesHttpRoute
        ? `This page really sent ${route} {"command":"${input.command}"} to the lab host.`
        : `${route} is the route the robot answers. This backend did not use it.`,
      provenance: input.usesHttpRoute ? 'observed' : 'inferred',
      origin: null,
      witness: input.usesHttpRoute
        ? 'This page’s fetch(), answered by apps/web/server/lab-host.mjs — the firmware’s own ' +
          'route, but served on the host. Wi-Fi is elided from the emulator image, so the ' +
          'guest’s TCP stack was never involved.'
        : 'Nothing sent a request. The behaviour model runs in this tab; this row exists so the ' +
          `stage is visible, and it is the route in hardware-map.json (${HTTP_COMMAND_ROUTE.handlerSymbol}, ` +
          `registered for ${HTTP_COMMAND_ROUTE.registeredMethod}, handler rejects non-` +
          `${HTTP_COMMAND_ROUTE.enforcedMethod ?? 'POST'} with 405).`,
      match: 'app-local',
      joint: null,
      nodeId: HTTP_COMMAND_ROUTE.nodeId,
      sourceRef: HTTP_COMMAND_ROUTE.sourceRef,
      seq: null,
    });

    // ------------------------------------------------------ firmware.command
    this.#put(trace, {
      layer: 'firmware.command',
      label:
        facts?.movementFunction === null || facts === null
          ? input.command
          : `${input.command} → ${facts.movementFunction}()`,
      detail:
        facts === null
          ? `"${input.command}" is not in the firmware's command vocabulary.`
          : `currentCommand = "${input.command}" dispatches ${facts.movementFunction ?? '(nothing)'}` +
            (facts.continuous ? ' — and never clears itself, so loop() repeats it.' : '.'),
      provenance: 'inferred',
      origin: null,
      witness:
        'The command→function mapping in hardware-map.json → commands.vocabulary. No backend emits ' +
        '"the firmware received a command" event, so this row is the mapping, shown so the step is ' +
        'not invisible. The next row is where a backend starts speaking.',
      match: 'app-local',
      joint: null,
      nodeId: facts?.movementFunction === null || facts === null ? 'movement' : `movement.${facts.movementFunction}`,
      sourceRef: facts?.commandSourceRef ?? null,
      seq: null,
    });

    // -------------------------------------------------------- movement.enter
    //
    // Laid down as `inferred` and REPLACED (not upgraded) when the banner
    // actually arrives on the wire. The two rows make different claims and the
    // witness text says which one is on screen.
    if (facts?.movementFunction !== null && facts !== null) {
      this.#put(trace, {
        layer: 'movement.enter',
        label: `${facts.movementFunction}()`,
        detail:
          `${facts.stepCount} extracted steps, ${facts.servoStepCount} of them servo writes` +
          (facts.joints.length === 0 ? '.' : `, touching ${facts.joints.join(' ')}.`),
        provenance: 'inferred',
        origin: null,
        witness:
          `Not yet seen on the wire. The firmware prints "${facts.logBanner ?? '(no banner)'}" on entry ` +
          `(${facts.logBannerSourceRef?.file ?? '?'}:${facts.logBannerSourceRef?.line ?? 0}); until that ` +
          'line arrives this row is hardware-map.json’s extraction, not a report.',
        match: 'app-local',
        joint: null,
        nodeId: `movement.${facts.movementFunction}`,
        sourceRef: facts.movementSourceRef,
        seq: null,
      });
    }

    this.#bump();
  }

  /**
   * Fold a telemetry event into the open trace.
   *
   * Deliberately narrow: only `servo.target` and the movement banner are
   * adopted. Everything else the stream carries is already shown elsewhere in
   * the app, and a trace that swallowed every log line would stop being a
   * causal chain and become a console.
   */
  ingest(event: SesameTelemetry): void {
    const trace = this.#traces[0];
    if (trace === undefined) return;

    const byId = event.traceId !== undefined && event.traceId === trace.id;
    const inWindow = performance.now() - trace.startedAt <= ADOPTION_WINDOW_MS;
    // An event carrying SOMEBODY ELSE'S trace id is not ours, ever. That is the
    // one case where the id is strictly better than the window.
    const foreignId = event.traceId !== undefined && event.traceId !== trace.id;
    if (!byId && (foreignId || !inWindow)) return;

    const match: RowMatch = byId ? 'trace-id' : 'time-window';
    if (byId) trace.carriedTraceId = true;
    else trace.windowAdopted += 1;

    if (event.type === 'log') {
      const banner = trace.facts?.logBanner ?? null;
      if (banner === null || event.text.trim() !== banner) return;
      const fn = trace.facts?.movementFunction ?? null;
      this.#put(trace, {
        layer: 'movement.enter',
        label: `${fn ?? '?'}()`,
        detail: `The banner "${event.text.trim()}" arrived on the log channel — the movement really started.`,
        provenance: event.provenance,
        origin: event.origin ?? null,
        witness:
          `${trace.facts?.logBannerSourceRef?.file ?? '?'}:${trace.facts?.logBannerSourceRef?.line ?? 0} ` +
          `prints this string on entry to ${fn ?? 'the movement'}. This row is that line, as it arrived.`,
        match,
        joint: null,
        nodeId: fn === null ? 'movement' : `movement.${fn}`,
        sourceRef: trace.facts?.movementSourceRef ?? null,
        seq: event.seq,
      });
      this.#bump();
      return;
    }

    if (event.type !== 'servo.target') return;
    const joint = event.joint;
    const deg = event.angleDeg;
    const origin = event.origin ?? null;

    // ---------------------------------------------------------- servo.target
    this.#put(trace, {
      layer: 'servo.target',
      label: `${joint}=${String(deg)}`,
      detail: `${SET_SERVO_ANGLE_FACTS.symbol}(${JOINT_FACTS[joint]?.firmwareIndex ?? '?'}, ${String(deg)}) — ${SET_SERVO_ANGLE_FACTS.clampStep}`,
      provenance: event.provenance,
      origin,
      witness:
        origin?.kind === 'emulator'
          ? 'The firmware hook really ran, inside the guest, on emulated silicon. Real instructions, ' +
            'no hardware. This is the strongest claim anything in this project can make.'
          : origin?.kind === 'host-model'
            ? 'A host-side behaviour model executed the extracted choreography. No firmware ran.'
            : origin?.kind === 'replay'
              ? 'Recorded bytes played back. Whatever produced them originally is gone.'
              : 'No origin was stated on this event, which is treated as “not known to be physical”.',
      match,
      joint,
      nodeId: `joint.${joint}`,
      sourceRef: SET_SERVO_ANGLE_FACTS.sourceRef,
      seq: event.seq,
    });

    // ------------------------------------------------------------ pwm.output
    this.#put(trace, this.#pwmRow(joint, deg, origin, match, event.seq));

    // ---------------------------------------------------------- joint.target
    const facts = JOINT_FACTS[joint];
    this.#put(trace, {
      layer: 'joint.target',
      label: `${joint}=${String(deg)}`,
      detail:
        `Servo channel ${facts?.firmwareIndex ?? '?'} drives the ${facts?.kind ?? 'joint'} named ` +
        `${joint}. The joint target is the servo command; nothing transforms it.`,
      provenance: 'inferred',
      origin: null,
      witness:
        'The servo channel → joint identity is authoritative (the firmware enum index IS the ' +
        `identity). The spatial name "${facts?.semanticName ?? 'unknown'}" is NOT verified and never ` +
        'will be: verifying it needs a physical robot, and there is not going to be one. There is ' +
        'also no position feedback of any kind, so this is a target, never a position.',
      match: 'app-local',
      joint,
      nodeId: `joint.${joint}`,
      sourceRef: facts?.sourceRef ?? null,
      seq: null,
    });

    this.#bump();
  }

  /**
   * Record what the 3D scene is actually showing for a joint.
   *
   * Read off `Object3D.quaternion` by the caller, not off React state — the
   * whole point of the row is that it is the *rendered* angle, so a stale
   * render loop must show up here as a stale number rather than be papered over
   * by the store's own value.
   */
  noteVisual(joint: JointName, sceneDeg: number): void {
    const trace = this.#traces[0];
    if (trace === undefined) return;
    if (!trace.rows.has(rowKey('servo.target', joint))) return;
    const existing = trace.rows.get(rowKey('visual.joint', joint));
    if (existing !== undefined && Math.abs(Number(existing.label.split('=')[1] ?? '0') - sceneDeg) < 0.05) {
      return;
    }
    this.#put(trace, {
      layer: 'visual.joint',
      label: `${joint}=${sceneDeg.toFixed(2)}`,
      detail: `The node named ${joint} in the three.js scene is at ${sceneDeg.toFixed(2)}°.`,
      provenance: 'inferred',
      origin: null,
      witness:
        'Recovered from Object3D.quaternion in this browser by the asset’s own rotation rule. It ' +
        'shows what was drawn, which is the commanded angle — not where a horn is. There is no ' +
        'physics here and no sensor anywhere.',
      match: 'app-local',
      joint,
      nodeId: `joint.${joint}`,
      sourceRef: null,
      seq: null,
    });
    this.#bump();
  }

  // ------------------------------------------------------------------ inner

  /**
   * The `pwm.output` row.
   *
   * Split out because it is the one row in this file whose honesty is
   * load-bearing, and it deserves to be readable on its own.
   */
  #pwmRow(
    joint: JointName,
    deg: number,
    origin: TelemetryOrigin | null,
    match: RowMatch,
    seq: number,
  ): PutRow {
    const clamped = Math.max(0, Math.min(180, Math.round(deg)));
    const pulse = quantiseCommandedAngle(clamped);
    const board = boardFor(origin);
    const pin = SERVO_PINS_BY_BOARD[board]?.[joint] ?? null;
    const others = pulse.aliases.filter((a) => a !== clamped);

    return {
      layer: 'pwm.output',
      label: `${joint} ${pulse.ticks} ticks · ${pulse.pulseUs.toFixed(2)} µs`,
      detail:
        `GPIO ${pin === null ? '?' : String(pin)} (${board}), ${PWM_FACTS.frequencyHz} Hz, ` +
        `${PWM_FACTS.timerWidthBits}-bit: map(${clamped}, 0, 180, 732, ${PWM_FACTS.effectiveMaxUs}) = ` +
        `${pulse.mappedUs} µs → ${pulse.ticks} ticks → ${pulse.pulseUs.toFixed(5)} µs. ` +
        (others.length === 0
          ? 'This command is distinguishable at the pin.'
          : `Indistinguishable from ${others.join('°, ')}° at the pin.`),
      provenance: 'inferred',
      origin: null,
      witness:
        'COMPUTED HERE, never observed. QEMU’s LEDC model stores the duty and produces no pulse, no ' +
        'edge and no waveform (Q3 §2–§3, register file read back over the gdbstub), and there is no ' +
        'physical robot to probe — so no pin has ever emitted this. The number is real arithmetic: ' +
        'ESP32Servo 3.0.9’s own map() and usToTicks(), including the clamp that turns ' +
        `${PWM_FACTS.attachCall} into a ${PWM_FACTS.effectiveMaxUs} µs maximum. Only ` +
        `${PWM_FACTS.distinctReachablePulseValues} of ${PWM_FACTS.commandableAngles} commandable ` +
        `angles are distinguishable at the pin. No channel number is shown because nothing in this ` +
        `repository records which of ${PWM_FACTS.channelsProgrammed.join('/')} carries which servo.`,
      match,
      joint,
      nodeId: PWM_FACTS.nodeId,
      sourceRef: PWM_FACTS.sourceRef,
      seq,
    };
  }

  #put(trace: MutableTrace, row: PutRow): void {
    const key = rowKey(row.layer, row.joint);
    const previous = trace.rows.get(key);
    trace.rows.set(key, {
      ...row,
      id: `${trace.id}:${key}`,
      rank: LAYER_RANK[row.layer],
      physicallyObserved: isPhysicallyObserved({
        provenance: row.provenance,
        ...(row.origin === null ? {} : { origin: row.origin }),
      }),
      tMs: performance.now() - trace.startedAt,
      updates: (previous?.updates ?? 0) + 1,
    });
  }

  #bump(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

type PutRow = Omit<TraceRow, 'id' | 'rank' | 'tMs' | 'updates' | 'physicallyObserved'>;

/**
 * Sort into causal order: layer rank first, then firmware enum order, then
 * arrival. Never alphabetical — `R4` really does come before `R3`.
 */
function orderRows(rows: Iterable<TraceRow>): TraceRow[] {
  const jointRank = (j: JointName | null): number =>
    j === null ? -1 : (JOINT_ORDER as readonly string[]).indexOf(j);
  return [...rows].sort(
    (a, b) => a.rank - b.rank || jointRank(a.joint) - jointRank(b.joint) || a.tMs - b.tMs,
  );
}

function freeze(t: MutableTrace): Trace {
  return {
    id: t.id,
    command: t.command,
    backendId: t.backendId,
    startedAt: t.startedAt,
    facts: t.facts,
    rows: orderRows(t.rows.values()),
    carriedTraceId: t.carriedTraceId,
    windowAdopted: t.windowAdopted,
  };
}

/**
 * The three-way label the report asks for, decided by the predicate rather than
 * by a string comparison on `provenance`.
 *
 * `isPhysicallyObserved()` is checked first and is false for everything this
 * project can produce; `OBSERVED ON HARDWARE` exists in this function so that
 * the branch is visible and so that the code would do the right thing if the
 * standing constraint were ever lifted. It is unreachable today, deliberately.
 */
export function traceBadge(row: {
  readonly provenance: Provenance;
  readonly origin: TelemetryOrigin | null;
  readonly physicallyObserved: boolean;
}): { readonly text: string; readonly tone: Provenance; readonly hardware: boolean } {
  if (row.physicallyObserved) {
    return { text: 'OBSERVED ON HARDWARE', tone: 'observed', hardware: true };
  }
  if (row.provenance === 'observed') {
    switch (row.origin?.kind) {
      case 'emulator':
        return { text: 'OBSERVED FROM EMULATOR', tone: 'observed', hardware: false };
      case 'replay':
        return { text: 'OBSERVED (REPLAY)', tone: 'observed', hardware: false };
      case 'host-model':
        return { text: 'OBSERVED (HOST MODEL)', tone: 'observed', hardware: false };
      default:
        return { text: 'OBSERVED IN THIS APP', tone: 'observed', hardware: false };
    }
  }
  if (row.provenance === 'simulated') return { text: 'SIMULATED', tone: 'simulated', hardware: false };
  return { text: 'INFERRED FOR EXPLANATION', tone: 'inferred', hardware: false };
}

/** Does this row belong to the current selection? Used for cross-highlighting. */
export function rowMatchesSelection(
  row: TraceRow,
  selection: { readonly joint: JointName | null; readonly nodeId: string | null },
): boolean {
  if (selection.joint !== null && row.joint === selection.joint) return true;
  if (selection.nodeId === null) return false;
  if (row.nodeId === selection.nodeId) return true;
  // A stage node (LEDC, setServoAngle) claims the layers it owns.
  const node = ARCH_NODE_BY_ID.get(selection.nodeId);
  return node !== undefined && node.traceLayers.includes(row.layer) && node.joints.length > 1;
}
