/**
 * The store's reduction, including the paths only a wire backend exercises.
 *
 * `oled.frame` events do not exist in V1 — the model emits expressions, not
 * pixels — so the only way to test that path before instrumented firmware
 * arrives is to synthesise the events. That is worth doing precisely because it
 * is the path a real emitter will take, and because it is the one place the app
 * must show `observed` pixels rather than `inferred` ones.
 */
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import { describe, expect, it } from 'vitest';

import { renderFace } from '../oled/framebuffer.js';
import { TelemetryStore } from '../state/telemetry-store.js';

let seq = 0;
const next = (): number => (seq += 1);

describe('provenance is preserved, never upgraded', () => {
  it('stores whatever the event said, per joint and in aggregate', () => {
    const store = new TelemetryStore();
    store.ingest({ seq: next(), provenance: 'observed', type: 'servo.target', joint: 'L3', angleDeg: 180 });
    store.ingest({ seq: next(), provenance: 'simulated', type: 'servo.target', joint: 'R1', angleDeg: 135 });
    store.ingest({ seq: next(), provenance: 'inferred', type: 'servo.target', joint: 'R3', angleDeg: 0 });

    expect(store.joints.L3.provenance).toBe('observed');
    expect(store.joints.R1.provenance).toBe('simulated');
    expect(store.joints.R3.provenance).toBe('inferred');
    expect(store.provenanceCounts).toEqual({ observed: 1, simulated: 1, inferred: 1 });
    // The banner tracks the most recent event that moved something.
    expect(store.drivingProvenance).toBe('inferred');
  });

  it('keeps a joint’s warnings so an out-of-range angle stays visible', () => {
    const store = new TelemetryStore();
    store.ingest({
      seq: next(),
      provenance: 'observed',
      type: 'servo.target',
      joint: 'R4',
      angleDeg: 200,
      warnings: [{ code: 'angle-out-of-range', message: '200 is outside 0-180' }],
    });
    // Flagged, not clamped: silently clamping on the receive side would hide
    // the bug that produced the bad value.
    expect(store.joints.R4.commandedDeg).toBe(200);
    expect(store.joints.R4.warnings[0]?.code).toBe('angle-out-of-range');
  });
});

describe('oled.frame off the wire', () => {
  it('shows the event’s own provenance for the pixels, not "inferred"', () => {
    const store = new TelemetryStore();
    const wave = renderFace('wave');
    expect(wave).not.toBeNull();
    if (wave === null) return;

    const event: SesameTelemetry = {
      seq: next(),
      provenance: 'observed',
      type: 'oled.frame',
      width: 128,
      height: 64,
      pixels: wave.base64,
    };
    store.ingest(event);

    expect(store.oledSource.kind).toBe('wire');
    expect(store.oledSource.pixelProvenance).toBe('observed');
    expect(store.panel.litPixels).toBe(wave.litPixels);
    expect(store.panel.base64).toBe(wave.base64);
  });

  it('reports a malformed payload instead of drawing something', () => {
    const store = new TelemetryStore();
    store.ingest({
      seq: next(),
      provenance: 'observed',
      type: 'oled.frame',
      width: 128,
      height: 64,
      pixels: 'AAAA',
    });
    expect(store.panel.writes).toBe(0);
    expect(store.unknownLines.some((l) => l.includes('1024'))).toBe(true);
  });
});

describe('an empty face is reported, not hidden', () => {
  it('records why nothing was drawn and leaves the panel alone', () => {
    const store = new TelemetryStore();
    const happy = renderFace('happy');
    if (happy !== null) {
      store.ingest({ seq: next(), provenance: 'simulated', type: 'face.expression', name: 'happy', frame: 0 });
    }
    const before = store.panel.base64;

    // A real emitter (unlike V1) could report the face it *tried* to set.
    store.ingest({ seq: next(), provenance: 'observed', type: 'face.expression', name: 'stand', frame: 0 });

    expect(store.emptyFace?.requested).toBe('stand');
    expect(store.emptyFace?.reason).toMatch(/ISSUE-20260823-004/);
    expect(store.panel.base64).toBe(before);
  });
});

describe('protocol.unknown is never dropped', () => {
  it('keeps the raw line verbatim', () => {
    const store = new TelemetryStore();
    store.ingest({
      seq: next(),
      provenance: 'observed',
      type: 'protocol.unknown',
      verb: 'pwm',
      args: ['6', '1500'],
      reason: 'unknown-verb',
      raw: '@SESAME pwm 6 1500',
    });
    expect(store.unknownLines).toContain('@SESAME pwm 6 1500');
  });
});

describe('reset', () => {
  it('clears the panel too, because a backend switch is a different robot', () => {
    const store = new TelemetryStore();
    store.ingest({ seq: next(), provenance: 'simulated', type: 'face.expression', name: 'happy', frame: 0 });
    store.ingest({ seq: next(), provenance: 'simulated', type: 'servo.target', joint: 'L3', angleDeg: 12 });
    expect(store.panel.litPixels).toBeGreaterThan(0);

    store.reset();
    expect(store.panel.litPixels).toBe(0);
    expect(store.joints.L3.commandedDeg).toBeNull();
    expect(store.drivingProvenance).toBeNull();
    expect(store.provenanceCounts).toEqual({ observed: 0, simulated: 0, inferred: 0 });
  });
});
