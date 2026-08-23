/**
 * Malformed input is normal input. The parser never throws on wire bytes and
 * never silently drops a `@SESAME` line: anything it cannot type becomes a
 * `protocol.unknown` carrying the raw line and a reason, and anything it can
 * type but distrusts becomes a warned event.
 */
import { describe, expect, it } from 'vitest';

import { parseTelemetryLine } from '../wire.js';
import type { ProtocolUnknownEvent, SesameTelemetry, TelemetryWarningCode } from '../events.js';

function one(line: string, options?: Parameters<typeof parseTelemetryLine>[1]): SesameTelemetry {
  const events = parseTelemetryLine(line, options);
  expect(events).toHaveLength(1);
  return events[0] as SesameTelemetry;
}

function reasonOf(line: string): string {
  const event = one(line);
  expect(event.type).toBe('protocol.unknown');
  return (event as ProtocolUnknownEvent).reason;
}

function warningCodes(line: string): TelemetryWarningCode[] {
  return (one(line).warnings ?? []).map((w) => w.code);
}

describe('malformed lines become typed protocol.unknown events', () => {
  it.each([
    ['@SESAME', 'missing-verb'],
    ['@SESAME frobnicate', 'unknown-verb'],
    ['@SESAME frobnicate a b c', 'unknown-verb'],
    ['@SESAME servo', 'bad-arity'],
    ['@SESAME servo R1', 'bad-arity'],
    ['@SESAME servo R1 abc', 'bad-angle'],
    ['@SESAME servo R1 9e9', 'bad-angle'],
    ['@SESAME servo R1 ninety', 'bad-angle'],
    ['@SESAME servo R9 90', 'unknown-joint'],
    ['@SESAME servo r1 90', 'unknown-joint'],
    ['@SESAME servo FL 90', 'unknown-joint'],
    ['@SESAME servo 0 90', 'unknown-joint'],
    ['@SESAME face', 'bad-arity'],
    ['@SESAME face wave x', 'bad-frame'],
    ['@SESAME face wave -1', 'bad-frame'],
    ['@SESAME face wave 1.5', 'bad-frame'],
    ['@SESAME oled', 'bad-arity'],
    ['@SESAME oled b64', 'bad-arity'],
    ['@SESAME oled rle AAAA', 'bad-encoding'],
    ['@SESAME oled b64 QUJD', 'bad-payload'],
    ['@SESAME oled b64 not!base64!', 'bad-payload'],
    ['@SESAME log', 'bad-arity'],
    ['@SESAME log stdout hello', 'bad-channel'],
    ['@SESAME hello', 'bad-arity'],
    ['@SESAME hello v1', 'bad-version'],
  ])('%s -> %s', (line, reason) => {
    expect(reasonOf(line)).toBe(reason);
  });

  it('preserves the raw line and the post-tag arguments', () => {
    const event = one('@SESAME servo s=3 x=t1 R9 72') as ProtocolUnknownEvent;
    expect(event).toEqual({
      type: 'protocol.unknown',
      seq: 3,
      provenance: 'observed',
      traceId: 't1',
      verb: 'servo',
      args: ['R9', '72'],
      reason: 'unknown-joint',
      raw: '@SESAME servo s=3 x=t1 R9 72',
    });
  });

  it('rejects a tag placed after the positional args, because tags come first', () => {
    // This is the one grammar trap worth a regression test: `t=` here is read as
    // the angle, not as a tag, and the line is rejected rather than silently
    // producing a servo event with the wrong angle.
    expect(reasonOf('@SESAME servo R2 t=1234 45')).toBe('bad-angle');
  });
});

describe('suspect-but-usable lines become warned events', () => {
  it('flags an angle outside the firmware clamp without dropping it', () => {
    const event = one('@SESAME servo R4 999');
    expect(event.type).toBe('servo.target');
    expect(event).toMatchObject({ joint: 'R4', angleDeg: 999 });
    expect(warningCodes('@SESAME servo R4 999')).toEqual(['angle-out-of-range']);
    expect(warningCodes('@SESAME servo R4 -1')).toEqual(['angle-out-of-range']);
    expect(warningCodes('@SESAME servo R4 0')).toEqual([]);
    expect(warningCodes('@SESAME servo R4 180')).toEqual([]);
  });

  it('can be configured to reject out-of-range angles instead', () => {
    const event = one('@SESAME servo R4 999', { rejectOutOfRangeAngle: true });
    expect(event.type).toBe('protocol.unknown');
    expect((event as ProtocolUnknownEvent).reason).toBe('angle-rejected');
  });

  it('flags a non-integer angle', () => {
    expect(warningCodes('@SESAME servo R4 72.5')).toEqual(['angle-not-integer']);
    expect(one('@SESAME servo R4 72.5')).toMatchObject({ angleDeg: 72.5 });
  });

  it('passes an unknown face through with a warning, because firmware can add faces', () => {
    const event = one('@SESAME face jubilant 0');
    expect(event.type).toBe('face.expression');
    expect(event).toMatchObject({ name: 'jubilant', frame: 0 });
    expect(warningCodes('@SESAME face jubilant 0')).toEqual(['unknown-face']);
  });

  it('flags a case-mismatched face name, since setFace() is case-insensitive', () => {
    expect(warningCodes('@SESAME face Wave 0')).toEqual(['face-name-case-mismatch']);
    expect(one('@SESAME face Wave 0')).toMatchObject({ name: 'Wave' });
  });

  it('flags a frame index past the end of the face', () => {
    expect(warningCodes('@SESAME face wave 1')).toEqual(['frame-out-of-range']);
    expect(warningCodes('@SESAME face rest 2')).toEqual([]);
    expect(warningCodes('@SESAME face rest 3')).toEqual(['frame-out-of-range']);
    expect(warningCodes('@SESAME face rest 9')).toEqual(['frame-out-of-range']);
  });

  it('ignores extra trailing positional args, for forward compatibility', () => {
    expect(warningCodes('@SESAME servo R1 90 extra')).toEqual(['trailing-args']);
    expect(one('@SESAME servo R1 90 extra')).toMatchObject({ joint: 'R1', angleDeg: 90 });
    expect(warningCodes('@SESAME face wave 0 extra')).toEqual(['trailing-args']);
    expect(warningCodes('@SESAME hello 1 emitter extra')).toEqual(['trailing-args']);
  });

  it('ignores unknown tags, for forward compatibility', () => {
    expect(warningCodes('@SESAME servo q=9 R1 90')).toEqual(['unknown-tag']);
    expect(one('@SESAME servo q=9 R1 90')).toMatchObject({ joint: 'R1', angleDeg: 90 });
  });

  it('ignores a recognised tag with an unusable value', () => {
    expect(warningCodes('@SESAME servo t=abc R1 90')).toEqual(['bad-tag-value']);
    expect(warningCodes('@SESAME servo p=z R1 90')).toEqual(['bad-tag-value']);
    expect(warningCodes('@SESAME servo s=-1 R1 90')).toEqual(['bad-tag-value']);
    expect(one('@SESAME servo p=z R1 90').provenance).toBe('observed');
  });

  it('warns about a hello from a newer protocol version but still parses it', () => {
    const event = one('@SESAME hello 2 future-fw');
    expect(event).toMatchObject({ type: 'protocol.hello', protocolVersion: 2, emitter: 'future-fw' });
    expect(warningCodes('@SESAME hello 2 future-fw')).toEqual(['unsupported-version']);
  });

  it('accepts the long spellings of the provenance tag', () => {
    expect(one('@SESAME servo p=simulated R1 90').provenance).toBe('simulated');
    expect(one('@SESAME servo p=inferred R1 90').provenance).toBe('inferred');
  });

  it('face checks can be disabled entirely', () => {
    expect(warningCodes('@SESAME face jubilant 0')).toEqual(['unknown-face']);
    expect(one('@SESAME face jubilant 0', { knownFaceNames: null }).warnings).toBeUndefined();
  });

  it('log text is taken raw to end of line, tags and all', () => {
    expect(one('@SESAME log uart s=1 p=o value=42')).toMatchObject({
      type: 'log',
      channel: 'uart',
      text: 's=1 p=o value=42',
    });
    expect(one('@SESAME log firmware')).toMatchObject({ channel: 'firmware', text: '' });
    expect(one('@SESAME log p=s emulator bridge reconnecting')).toMatchObject({
      channel: 'emulator',
      text: 'bridge reconnecting',
      provenance: 'simulated',
    });
  });
});
