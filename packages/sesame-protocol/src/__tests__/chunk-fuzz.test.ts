/**
 * The bug that would otherwise bite in production.
 *
 * A UART socket hands you bytes, not lines. If the parser's output depends on
 * where the OS happened to cut a read, the failure is intermittent, unreliably
 * reproducible, and will be blamed on Renode. So: feed the *same* byte stream
 * split at every possible offset, at every pair of offsets in a smaller stream,
 * one byte at a time, and at hundreds of seeded random cut sets — and assert the
 * emitted event sequence is identical every single time.
 */
import { describe, expect, it } from 'vitest';

import { SesameTelemetryParser } from '../parser.js';
import type { SesameTelemetry } from '../events.js';
import { makeRandom, nastyStream } from './fixtures.js';

const STREAM = nastyStream();

function parseWithCuts(stream: Uint8Array, cuts: readonly number[]): SesameTelemetry[] {
  const parser = new SesameTelemetryParser();
  const events: SesameTelemetry[] = [];
  let previous = 0;
  for (const cut of cuts) {
    events.push(...parser.push(stream.subarray(previous, cut)));
    previous = cut;
  }
  events.push(...parser.push(stream.subarray(previous)));
  events.push(...parser.flush());
  return events;
}

const REFERENCE = parseWithCuts(STREAM, []);

describe('chunk-boundary fuzzing', () => {
  it('the reference parse of the nasty stream is non-trivial', () => {
    expect(STREAM.length).toBeGreaterThan(1400);
    expect(REFERENCE.length).toBeGreaterThan(15);
    const kinds = new Set(REFERENCE.map((e) => e.type));
    expect(kinds).toContain('servo.target');
    expect(kinds).toContain('face.expression');
    expect(kinds).toContain('oled.frame');
    expect(kinds).toContain('log');
    expect(kinds).toContain('protocol.hello');
    expect(kinds).toContain('protocol.unknown');
  });

  it('is identical when split at every single offset', () => {
    for (let cut = 0; cut <= STREAM.length; cut++) {
      const actual = parseWithCuts(STREAM, [cut]);
      if (JSON.stringify(actual) !== JSON.stringify(REFERENCE)) {
        // Only build the (large) diff message when something actually failed.
        expect({ cut, actual }).toEqual({ cut, actual: REFERENCE });
      }
    }
  });

  it('is identical when fed one byte at a time', () => {
    const cuts = Array.from({ length: STREAM.length }, (_, i) => i);
    expect(parseWithCuts(STREAM, cuts)).toEqual(REFERENCE);
  });

  it('is identical for 500 seeded random cut sets', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = makeRandom(seed);
      const count = 1 + Math.floor(random() * 8);
      const cuts = Array.from({ length: count }, () => Math.floor(random() * (STREAM.length + 1)))
        .sort((a, b) => a - b);
      const actual = parseWithCuts(STREAM, cuts);
      if (JSON.stringify(actual) !== JSON.stringify(REFERENCE)) {
        expect({ seed, cuts, actual }).toEqual({ seed, cuts, actual: REFERENCE });
      }
    }
  });

  it('is identical for every pair of split points in a smaller stream', () => {
    const small = new TextEncoder().encode(
      'boot\r\n@SESAME servo R1 90\r@SESAME face wave 0\n@SESAME servo L4 180\ntail',
    );
    const reference = parseWithCuts(small, []);
    for (let a = 0; a <= small.length; a++) {
      for (let b = a; b <= small.length; b++) {
        const actual = parseWithCuts(small, [a, b]);
        if (JSON.stringify(actual) !== JSON.stringify(reference)) {
          expect({ a, b, actual }).toEqual({ a, b, actual: reference });
        }
      }
    }
  });

  it('a CRLF split between the CR and the LF still yields one terminator', () => {
    const stream = new TextEncoder().encode('@SESAME servo R1 90\r\n@SESAME servo R2 91\r\n');
    const reference = parseWithCuts(stream, []);
    expect(reference).toHaveLength(2);
    for (let cut = 0; cut <= stream.length; cut++) {
      expect(parseWithCuts(stream, [cut])).toEqual(reference);
    }
  });

  it('oversized-line handling is chunk-independent', () => {
    const stream = new TextEncoder().encode(`x${'A'.repeat(400)}\n@SESAME servo R1 5\n`);
    const run = (cuts: readonly number[]): SesameTelemetry[] => {
      const parser = new SesameTelemetryParser({ maxLineBytes: 64 });
      const events: SesameTelemetry[] = [];
      let previous = 0;
      for (const cut of cuts) {
        events.push(...parser.push(stream.subarray(previous, cut)));
        previous = cut;
      }
      events.push(...parser.push(stream.subarray(previous)));
      events.push(...parser.flush());
      return events;
    };
    const reference = run([]);
    expect(reference).toHaveLength(2);
    expect(reference[0]).toMatchObject({ type: 'log', channel: 'emulator' });
    expect((reference[0] as { text: string }).text).toContain('401 bytes');
    expect(reference[1]).toMatchObject({ type: 'servo.target', joint: 'R1', angleDeg: 5 });

    for (let cut = 0; cut <= stream.length; cut++) {
      expect(run([cut])).toEqual(reference);
    }
    expect(run(Array.from({ length: stream.length }, (_, i) => i))).toEqual(reference);
    for (let size = 1; size <= 130; size++) {
      const cuts: number[] = [];
      for (let at = size; at < stream.length; at += size) cuts.push(at);
      expect(run(cuts)).toEqual(reference);
    }
  });
});
