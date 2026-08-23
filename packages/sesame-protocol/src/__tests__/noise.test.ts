/**
 * The stream is noisy by construction: firmware boot logging, a Renode socket
 * that may or may not have been opened with `telnetMode: false`, and a byte
 * stream with no framing guarantees. None of that may cost us a telemetry line,
 * and none of it may cost us the surrounding log text either — that text is a
 * telemetry channel in its own right.
 */
import { describe, expect, it } from 'vitest';

import { SesameTelemetryParser, parseTelemetryStream } from '../parser.js';
import type { LogEvent, SesameTelemetry } from '../events.js';
import { encodeOledFrame, decodeOledFrame } from '../oled.js';
import { sampleFrame } from './fixtures.js';

function texts(events: readonly SesameTelemetry[]): string[] {
  return events.filter((e): e is LogEvent => e.type === 'log').map((e) => e.text);
}

describe('noisy streams', () => {
  it('keeps boot logging interleaved with telemetry, in order', () => {
    const events = parseTelemetryStream(
      [
        'ets Jul 29 2019 12:21:46',
        'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)',
        '@SESAME servo R1 90',
        'SSD1306 allocation ok',
        '@SESAME face happy 0',
        'WiFi AP started: Sesame-BETA',
      ].join('\n') + '\n',
    );
    expect(events.map((e) => e.type)).toEqual([
      'log',
      'log',
      'servo.target',
      'log',
      'face.expression',
      'log',
    ]);
    expect(texts(events)).toEqual([
      'ets Jul 29 2019 12:21:46',
      'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)',
      'SSD1306 allocation ok',
      'WiFi AP started: Sesame-BETA',
    ]);
    for (const event of events) {
      if (event.type === 'log') expect(event.channel).toBe('uart');
    }
  });

  it('recovers a sentinel that a stray print pushed into the middle of a line', () => {
    const events = parseTelemetryStream('setServoAngle: @SESAME servo L1 12\n');
    expect(events).toEqual([
      { type: 'log', seq: 0, provenance: 'observed', channel: 'uart', text: 'setServoAngle:' },
      { type: 'servo.target', seq: 1, provenance: 'observed', joint: 'L1', angleDeg: 12 },
    ]);
  });

  it('splits two segments that a missing newline concatenated', () => {
    const events = parseTelemetryStream('@SESAME servo L2 33@SESAME face happy 0\n');
    expect(events.map((e) => e.type)).toEqual(['servo.target', 'face.expression']);
    expect(events[0]).toMatchObject({ joint: 'L2', angleDeg: 33 });
    expect(events[1]).toMatchObject({ name: 'happy', frame: 0 });
  });

  it('does not treat @SESAMEFOO as a sentinel', () => {
    const events = parseTelemetryStream('@SESAMEFOO servo R1 90\n');
    expect(events).toEqual([
      {
        type: 'log',
        seq: 0,
        provenance: 'observed',
        channel: 'uart',
        text: '@SESAMEFOO servo R1 90',
      },
    ]);
  });

  it('strips telnet IAC negotiation spliced into the stream', () => {
    const encoder = new TextEncoder();
    const iac = new Uint8Array([0xff, 0xfb, 0x01, 0xff, 0xfd, 0x03, 0xff, 0xf9]);
    const parser = new SesameTelemetryParser();
    const events = [
      ...parser.push(iac),
      ...parser.push(encoder.encode('@SESAME servo R1 90')),
      ...parser.push(new Uint8Array([0xff, 0xfe, 0x22])),
      ...parser.push(encoder.encode('\n')),
      ...parser.flush(),
    ];
    expect(events).toEqual([
      { type: 'servo.target', seq: 0, provenance: 'observed', joint: 'R1', angleDeg: 90 },
    ]);
  });

  it('drops lone 0xFF and other undecodable bytes rather than corrupting a line', () => {
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('@SESAME servo R1 90'),
      0x80,
      0x81,
      ...encoder.encode('\n'),
    ]);
    expect(parseTelemetryStream(bytes)).toEqual([
      { type: 'servo.target', seq: 0, provenance: 'observed', joint: 'R1', angleDeg: 90 },
    ]);
  });

  it('handles LF, CRLF and CR-only line endings identically', () => {
    const body = '@SESAME servo R1 1@@@SESAME servo R2 2@@@SESAME servo L1 3@@';
    for (const terminator of ['\n', '\r\n', '\r']) {
      const events = parseTelemetryStream(body.replaceAll('@@', terminator));
      expect(events.map((e) => (e as { angleDeg: number }).angleDeg)).toEqual([1, 2, 3]);
    }
  });

  it('emits a trailing partial line only on flush', () => {
    const parser = new SesameTelemetryParser();
    expect(parser.push('@SESAME servo R1 90')).toEqual([]);
    expect(parser.pendingBytes).toBe(19);
    expect(parser.flush()).toEqual([
      { type: 'servo.target', seq: 0, provenance: 'observed', joint: 'R1', angleDeg: 90 },
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it('holds a trailing CR until it knows whether an LF follows', () => {
    const parser = new SesameTelemetryParser();
    expect(parser.push('@SESAME servo R1 90\r')).toEqual([]);
    expect(parser.push('\n@SESAME servo R2 91\n').map((e) => e.type)).toEqual([
      'servo.target',
      'servo.target',
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it('skips blank lines entirely', () => {
    expect(parseTelemetryStream('\n\r\n\r\n   \n\t\n')).toEqual([]);
  });

  it('discards an oversized line without losing the lines around it', () => {
    const events = parseTelemetryStream(
      `@SESAME servo R1 1\n${'B'.repeat(5000)}\n@SESAME servo R2 2\n`,
      { maxLineBytes: 256 },
    );
    expect(events.map((e) => e.type)).toEqual(['servo.target', 'log', 'servo.target']);
    const overflow = events[1] as LogEvent;
    expect(overflow.channel).toBe('emulator');
    expect(overflow.text).toContain('oversized line discarded: 5000 bytes');
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('does not treat a full OLED frame as oversized at the default limit', () => {
    const frame = sampleFrame(11);
    const events = parseTelemetryStream(`@SESAME oled b64 ${encodeOledFrame(frame)}\n`);
    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; pixels: string };
    expect(event.type).toBe('oled.frame');
    expect(decodeOledFrame(event.pixels)).toEqual(frame);
  });

  it('never throws on arbitrary binary garbage', () => {
    const random = new Uint8Array(20000);
    let state = 12345;
    for (let i = 0; i < random.length; i++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      random[i] = (state >> 16) & 0xff;
    }
    expect(() => parseTelemetryStream(random, { maxLineBytes: 1024 })).not.toThrow();
  });

  it('a replay harness can label its whole stream as simulated', () => {
    const events = parseTelemetryStream('boot\n@SESAME servo R1 90\n', {
      defaultProvenance: 'simulated',
    });
    expect(events.every((e) => e.provenance === 'simulated')).toBe(true);
  });

  it('an explicit p= tag overrides the stream default per event', () => {
    const events = parseTelemetryStream('@SESAME servo p=i R1 90\n', {
      defaultProvenance: 'simulated',
    });
    expect(events[0]?.provenance).toBe('inferred');
  });
});
