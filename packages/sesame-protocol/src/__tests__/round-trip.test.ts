import { describe, expect, it } from 'vitest';

import { parseTelemetryLine, serialize, serializeLine } from '../wire.js';
import { parseTelemetryStream } from '../parser.js';
import { TELEMETRY_TYPES, type SesameTelemetry } from '../events.js';
import { warningFreeEvents } from './fixtures.js';

const EVENTS = warningFreeEvents();

function roundTrip(event: SesameTelemetry): SesameTelemetry[] {
  return parseTelemetryLine(serialize(event, { tags: 'all' }));
}

describe('round-trip', () => {
  it('covers every event kind the wire can express', () => {
    const kinds = new Set(EVENTS.map((e) => e.type));
    // protocol.unknown is only ever produced by the parser, never authored, so
    // it is round-tripped separately below.
    expect([...kinds].sort()).toEqual(
      TELEMETRY_TYPES.filter((t) => t !== 'protocol.unknown')
        .slice()
        .sort(),
    );
    expect(EVENTS.length).toBeGreaterThan(150);
  });

  it.each(EVENTS.map((e, i) => [i, e] as const))(
    'serialize(tags:all) -> parse is the identity for event %i',
    (_index, event) => {
      const line = serialize(event, { tags: 'all' });
      expect(line.includes('\n')).toBe(false);
      expect(line.includes('\r')).toBe(false);
      const parsed = roundTrip(event);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(event);
    },
  );

  it('emits no warnings for any well-formed event', () => {
    for (const event of EVENTS) {
      const parsed = roundTrip(event)[0];
      expect(parsed && 'warnings' in parsed).toBe(false);
    }
  });

  it('default (auto) tagging round-trips everything except seq', () => {
    for (const event of EVENTS) {
      const parsed = parseTelemetryLine(serialize(event), { startSeq: event.seq })[0];
      expect(parsed).toEqual(event);
    }
  });

  it('auto tagging omits s= and omits p= for observed events', () => {
    const line = serialize({
      type: 'servo.target',
      seq: 17,
      provenance: 'observed',
      joint: 'R4',
      angleDeg: 72,
    });
    expect(line).toBe('@SESAME servo R4 72');
  });

  it('auto tagging keeps p= for simulated and inferred events', () => {
    expect(
      serialize({
        type: 'servo.target',
        seq: 1,
        provenance: 'simulated',
        joint: 'L3',
        angleDeg: 10,
      }),
    ).toBe('@SESAME servo p=s L3 10');
    expect(
      serialize({
        type: 'servo.target',
        seq: 1,
        provenance: 'inferred',
        joint: 'L3',
        angleDeg: 10,
      }),
    ).toBe('@SESAME servo p=i L3 10');
  });

  it('matches the two example lines from the plan verbatim', () => {
    expect(
      serialize({ type: 'servo.target', seq: 0, provenance: 'observed', joint: 'R4', angleDeg: 72 }),
    ).toBe('@SESAME servo R4 72');
    expect(
      serialize({ type: 'face.expression', seq: 0, provenance: 'observed', name: 'wave', frame: 0 }),
    ).toBe('@SESAME face wave 0');

    expect(parseTelemetryLine('@SESAME servo R4 72')).toEqual([
      { type: 'servo.target', seq: 0, provenance: 'observed', joint: 'R4', angleDeg: 72 },
    ]);
    expect(parseTelemetryLine('@SESAME face wave 0')).toEqual([
      { type: 'face.expression', seq: 0, provenance: 'observed', name: 'wave', frame: 0 },
    ]);
  });

  it('serializeLine appends exactly one LF', () => {
    const event = EVENTS[0] as SesameTelemetry;
    expect(serializeLine(event)).toBe(`${serialize(event)}\n`);
  });

  it('re-serializing a whole stream reproduces the same event sequence', () => {
    const first = EVENTS.map((e) => serializeLine(e, { tags: 'all' })).join('');
    const parsed = parseTelemetryStream(first);
    expect(parsed).toEqual(EVENTS);
    const second = parsed.map((e) => serializeLine(e, { tags: 'all' })).join('');
    expect(second).toBe(first);
  });

  it('protocol.unknown is a serialization fixed point, byte for byte', () => {
    const raws = [
      '@SESAME frobnicate 1 2 3',
      '@SESAME servo R9 72',
      '@SESAME servo s=7 R1 abc',
      '@SESAME face',
      '@SESAME oled b91 AAAA',
      '@SESAME log nowhere text',
      '@SESAME hello v1',
      '@SESAME',
    ];
    for (const raw of raws) {
      const parsed = parseTelemetryLine(raw);
      expect(parsed).toHaveLength(1);
      const event = parsed[0] as SesameTelemetry;
      expect(event.type).toBe('protocol.unknown');
      expect(serialize(event)).toBe(raw);
      // and parsing the re-serialized form is a fixed point
      expect(parseTelemetryLine(serialize(event))).toEqual(parsed);
    }
  });

  it('honours an explicit s= tag and advances the counter past it', () => {
    const events = parseTelemetryStream(
      '@SESAME servo s=100 R1 10\n@SESAME servo R2 20\n@SESAME servo s=5 L1 30\n@SESAME servo L2 40\n',
    );
    expect(events.map((e) => e.seq)).toEqual([100, 101, 5, 102]);
  });
});
