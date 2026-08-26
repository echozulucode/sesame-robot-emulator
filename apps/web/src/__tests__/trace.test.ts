/**
 * "See the Signal" — causal order, per-layer provenance, and the two things the
 * feature must never do.
 *
 * The two: it must never label anything `OBSERVED ON HARDWARE`, and it must
 * never present `pwm.output` as anything but inferred. Both are asserted for
 * every backend shape here rather than left to the UI's good behaviour.
 */
import { quantiseCommandedAngle } from '@sesame-lab/sesame-model';
import type { SesameTelemetry, TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { PWM_FACTS } from '../generated/architecture-graph.js';
import { TraceStore, TRACE_LAYERS, traceBadge, type Trace } from '../state/trace-store.js';

const EMULATOR: TelemetryOrigin = {
  kind: 'emulator',
  engine: 'qemu-system-xtensa/9.2.2',
  board: 'distro-v1-esp32',
  elided: ['wifi', 'ssd1306-panel'],
};
const HOST_MODEL: TelemetryOrigin = { kind: 'host-model' };

let seq = 0;
const servo = (
  joint: 'R1' | 'L2' | 'R4' | 'L3',
  angleDeg: number,
  extra: Partial<SesameTelemetry> = {},
): SesameTelemetry =>
  ({
    seq: (seq += 1),
    type: 'servo.target',
    joint,
    angleDeg,
    provenance: 'simulated',
    ...extra,
  }) as SesameTelemetry;

function openWave(store: TraceStore, opts: { qemu: boolean }): string {
  const id = store.mintTraceId('wave');
  store.open({
    traceId: id,
    command: 'wave',
    backendId: opts.qemu ? 'qemu' : 'sim',
    emulatorOrigin: opts.qemu ? EMULATOR : null,
    usesHttpRoute: opts.qemu,
  });
  return id;
}

const layersOf = (trace: Trace): string[] => trace.rows.map((r) => r.layer);

beforeEach(() => {
  seq = 0;
});

describe('the ladder is in causal order', () => {
  it('never emits a row out of rank order', () => {
    const store = new TraceStore();
    const id = openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { provenance: 'simulated', origin: HOST_MODEL, traceId: id }));
    store.noteVisual('L3', 180);

    const trace = store.active as Trace;
    const ranks = trace.rows.map((r) => r.rank);
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
    // The report's eight rungs, all present for one servo write.
    expect(new Set(layersOf(trace))).toEqual(new Set(TRACE_LAYERS));
  });

  it('orders servo rows by firmware enum index, not alphabetically', () => {
    const store = new TraceStore();
    const id = openWave(store, { qemu: false });
    for (const [joint, deg] of [
      ['L3', 180],
      ['R1', 100],
      ['R4', 80],
    ] as const) {
      store.ingest(servo(joint, deg, { origin: HOST_MODEL, traceId: id }));
    }
    const trace = store.active as Trace;
    const servoJoints = trace.rows.filter((r) => r.layer === 'servo.target').map((r) => r.joint);
    // enum order is R1 R2 L1 L2 R4 R3 L3 L4
    expect(servoJoints).toEqual(['R1', 'R4', 'L3']);
  });

  it('collapses repeated writes to one row with an update count', () => {
    const store = new TraceStore();
    const id = openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { origin: HOST_MODEL, traceId: id }));
    store.ingest(servo('L3', 180, { origin: HOST_MODEL, traceId: id }));
    const rows = (store.active as Trace).rows.filter((r) => r.layer === 'servo.target');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updates).toBe(2);
  });
});

describe('per-layer provenance', () => {
  it('under the simulator: servo.target is SIMULATED, http.request is inferred', () => {
    const store = new TraceStore();
    const id = openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { provenance: 'simulated', origin: HOST_MODEL, traceId: id }));
    const rows = new Map((store.active as Trace).rows.map((r) => [r.layer, r]));

    // `simulated` is the model's own tag, and it outranks any origin dressing:
    // a host model computing what the robot would do is exactly SIMULATED.
    expect(rows.get('servo.target')?.provenance).toBe('simulated');
    expect(rows.get('servo.target')?.origin?.kind).toBe('host-model');
    expect(traceBadge(rows.get('servo.target')!).text).toBe('SIMULATED');
    // A behaviour model sent no HTTP, and the row says so instead of implying it did.
    expect(rows.get('http.request')?.provenance).toBe('inferred');
    expect(rows.get('http.request')?.detail).toContain('did not use it');
  });

  it('under QEMU: servo.target is OBSERVED FROM EMULATOR and http.request really happened', () => {
    const store = new TraceStore();
    openWave(store, { qemu: true });
    store.ingest(servo('L3', 180, { provenance: 'observed', origin: EMULATOR }));
    const rows = new Map((store.active as Trace).rows.map((r) => [r.layer, r]));

    const target = rows.get('servo.target')!;
    expect(target.provenance).toBe('observed');
    expect(target.origin?.kind).toBe('emulator');
    expect(traceBadge(target).text).toBe('OBSERVED FROM EMULATOR');
    expect(target.physicallyObserved).toBe(false);

    expect(rows.get('http.request')?.provenance).toBe('observed');
    expect(rows.get('http.request')?.witness).toContain('lab-host.mjs');
  });

  it('promotes movement.enter from inferred to the wire when the banner arrives', () => {
    const store = new TraceStore();
    openWave(store, { qemu: true });
    const before = (store.active as Trace).rows.find((r) => r.layer === 'movement.enter');
    expect(before?.provenance).toBe('inferred');
    expect(before?.witness).toContain('Not yet seen on the wire');

    store.ingest({
      seq: 99,
      type: 'log',
      channel: 'uart',
      text: 'WAVE',
      provenance: 'observed',
      origin: EMULATOR,
    } as SesameTelemetry);

    const after = (store.active as Trace).rows.find((r) => r.layer === 'movement.enter');
    expect(after?.provenance).toBe('observed');
    expect(after?.origin?.kind).toBe('emulator');
    expect(traceBadge(after!).text).toBe('OBSERVED FROM EMULATOR');
  });
});

describe('pwm.output is the honest row', () => {
  it('is inferred on every backend, and never physically observed', () => {
    for (const qemu of [false, true]) {
      const store = new TraceStore();
      openWave(store, { qemu });
      store.ingest(
        servo('L3', 180, {
          provenance: qemu ? 'observed' : 'simulated',
          origin: qemu ? EMULATOR : HOST_MODEL,
        }),
      );
      const pwm = (store.active as Trace).rows.find((r) => r.layer === 'pwm.output');
      expect(pwm?.provenance).toBe('inferred');
      expect(pwm?.physicallyObserved).toBe(false);
      expect(traceBadge(pwm!).text).toBe('INFERRED FOR EXPLANATION');
      expect(pwm?.witness).toContain('no waveform');
    }
  });

  it('shows the real quantised pulse, not the pulse the firmware asked for', () => {
    const store = new TraceStore();
    openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { origin: HOST_MODEL }));
    const pwm = (store.active as Trace).rows.find((r) => r.layer === 'pwm.output');

    const expected = quantiseCommandedAngle(180);
    expect(expected.pulseUs).toBe(2500);
    expect(expected.ticks).toBe(PWM_FACTS.maxTick);
    expect(pwm?.label).toContain(`${expected.ticks} ticks`);
    expect(pwm?.label).toContain('2500.00 µs');
    // attach() asked for 2929; the library clamped it. Both numbers are true and
    // only one of them is a pulse.
    expect(pwm?.detail).not.toContain('2929');
    expect(PWM_FACTS.requestedMaxUs).toBe(2929);
  });

  it('names the angles a servo cannot tell apart', () => {
    const store = new TraceStore();
    openWave(store, { qemu: false });
    store.ingest(servo('R1', 90, { origin: HOST_MODEL }));
    const pwm = (store.active as Trace).rows.find((r) => r.layer === 'pwm.output');
    // 89 and 90 land on the same tick. That separation is the lesson.
    expect(quantiseCommandedAngle(90).aliases).toEqual([89, 90]);
    expect(pwm?.detail).toContain('Indistinguishable from 89°');
  });

  it('prints no channel number, because nothing in the repo records one', () => {
    const store = new TraceStore();
    openWave(store, { qemu: true });
    store.ingest(servo('L3', 180, { provenance: 'observed', origin: EMULATOR }));
    const pwm = (store.active as Trace).rows.find((r) => r.layer === 'pwm.output');
    expect(pwm?.label).not.toMatch(/channel/i);
    expect(`${pwm?.label} ${pwm?.detail}`).not.toMatch(/channel\s*=\s*\d/);
    expect(pwm?.witness).toContain('No channel number is shown');
  });

  it('uses the origin’s board for the pin, not the map’s active board', () => {
    const store = new TraceStore();
    openWave(store, { qemu: true });
    store.ingest(servo('R1', 90, { provenance: 'observed', origin: EMULATOR }));
    const pwm = (store.active as Trace).rows.find((r) => r.layer === 'pwm.output');
    // distro-v1 R1 is GPIO 15; s2-mini R1 is GPIO 1. Reporting the S2 pin beside
    // an ESP32 run would be a quiet lie about which board executed.
    expect(pwm?.detail).toContain('GPIO 15 (distro-v1)');
  });
});

describe('correlation is never dressed up as causation', () => {
  it('marks id-carrying events causal', () => {
    const store = new TraceStore();
    const id = openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { origin: HOST_MODEL, traceId: id }));
    const trace = store.active as Trace;
    expect(trace.carriedTraceId).toBe(true);
    expect(trace.rows.find((r) => r.layer === 'servo.target')?.match).toBe('trace-id');
  });

  it('marks id-less events as a time window, and says how many', () => {
    const store = new TraceStore();
    openWave(store, { qemu: true });
    store.ingest(servo('L3', 180, { provenance: 'observed', origin: EMULATOR }));
    const trace = store.active as Trace;
    expect(trace.carriedTraceId).toBe(false);
    expect(trace.windowAdopted).toBeGreaterThan(0);
    expect(trace.rows.find((r) => r.layer === 'servo.target')?.match).toBe('time-window');
  });

  it('refuses an event carrying somebody else’s trace id', () => {
    const store = new TraceStore();
    openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { origin: HOST_MODEL, traceId: 'someone-else-0001' }));
    expect(layersOf(store.active as Trace)).not.toContain('servo.target');
  });
});

describe('nothing is ever physically observed', () => {
  it('holds for every row of every backend shape', () => {
    for (const origin of [HOST_MODEL, EMULATOR, { kind: 'replay' } as const, undefined]) {
      const store = new TraceStore();
      openWave(store, { qemu: origin?.kind === 'emulator' });
      store.ingest(
        servo('L3', 180, {
          provenance: 'observed',
          ...(origin === undefined ? {} : { origin }),
        }),
      );
      store.noteVisual('L3', 180);
      for (const row of (store.active as Trace).rows) {
        expect(row.physicallyObserved).toBe(false);
        expect(traceBadge(row).hardware).toBe(false);
        expect(traceBadge(row).text).not.toBe('OBSERVED ON HARDWARE');
      }
    }
  });

  it('reports visual.joint as what the SCENE shows, marked inferred', () => {
    const store = new TraceStore();
    openWave(store, { qemu: false });
    store.ingest(servo('L3', 180, { origin: HOST_MODEL }));
    // Deliberately not 180: the scene is behind, and the row must show that.
    store.noteVisual('L3', 173.5);
    const row = (store.active as Trace).rows.find((r) => r.layer === 'visual.joint');
    expect(row?.label).toBe('L3=173.50');
    expect(row?.provenance).toBe('inferred');
    expect(row?.witness).toContain('Object3D.quaternion');
  });

  it('does not invent a visual row for a joint nothing commanded', () => {
    const store = new TraceStore();
    openWave(store, { qemu: false });
    store.noteVisual('R3', 90);
    expect(layersOf(store.active as Trace)).not.toContain('visual.joint');
  });
});
