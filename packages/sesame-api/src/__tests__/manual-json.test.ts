/**
 * `handleApiCommand()`'s hand-rolled body scanner.
 *
 * The acceptance set of a parser built out of `indexOf` and `substring` is not
 * JSON's, and the difference is the whole reason this package cannot just
 * `JSON.parse` the body. Each case cites the statement that produces it.
 */
import { describe, expect, it } from 'vitest';

import { parseApiCommandBody } from '../manual-json.js';

describe('the well-formed cases', () => {
  it('accepts a command', () => {
    expect(parseApiCommandBody('{"command":"wave"}')).toEqual({
      ok: true,
      faceOnly: false,
      face: '',
      command: 'wave',
    });
  });

  it('accepts the spaced spelling of both keys', () => {
    expect(parseApiCommandBody('{"command": "wave"}')).toMatchObject({ command: 'wave' });
    expect(parseApiCommandBody('{"face": "happy"}')).toMatchObject({
      faceOnly: true,
      face: 'happy',
    });
  });

  it('treats a face with no command key as face-only', () => {
    expect(parseApiCommandBody('{"face":"happy"}')).toEqual({
      ok: true,
      faceOnly: true,
      face: 'happy',
      command: '',
    });
  });

  it('honours both fields when both are present', () => {
    expect(parseApiCommandBody('{"command":"wave","face":"happy"}')).toEqual({
      ok: true,
      faceOnly: false,
      face: 'happy',
      command: 'wave',
    });
  });
});

describe('the quirks — reproduced, not fixed', () => {
  it('ignores a face at index 0, because the test is a strict "> 0" (:323)', () => {
    // No enclosing brace, so `"face":"` matches at offset 0 and reads as absent.
    expect(parseApiCommandBody('"face":"rest"')).toEqual({
      ok: false,
      status: 400,
      error: 'Missing command field',
    });
  });

  it('rejects a space before the colon (:338-:341)', () => {
    expect(parseApiCommandBody('{"command" : "wave"}')).toEqual({
      ok: false,
      status: 400,
      error: 'Missing command field',
    });
  });

  it('is not JSON: leading and trailing garbage are fine', () => {
    expect(parseApiCommandBody('garbage{"command":"wave"}trailing')).toMatchObject({
      command: 'wave',
    });
    expect(parseApiCommandBody('[{"command":"wave"}]')).toMatchObject({ command: 'wave' });
  });

  it('has no escape handling — the scan stops at the first quote', () => {
    expect(parseApiCommandBody('{"command":"wa\\"ve"}')).toMatchObject({ command: 'wa\\' });
  });

  it('rejects an empty command with a different error than a missing one (:352)', () => {
    expect(parseApiCommandBody('{"command":""}')).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid command format',
    });
  });

  it('accepts an empty face and extracts nothing from it', () => {
    // faceEnd === faceOnlyStart, so `face` stays empty — but `faceOnly` is
    // still true, so the handler answers 200 "Face updated" having called
    // nothing. A no-op with a success message.
    expect(parseApiCommandBody('{"face":""}')).toEqual({
      ok: true,
      faceOnly: true,
      face: '',
      command: '',
    });
  });

  it('loses face-only status to any occurrence of "command":, even a useless one', () => {
    // The faceOnly test greps the raw body for the bare key; the extraction
    // that follows demands the stricter `"command":"`. A numeric value
    // satisfies the first and fails the second, so a body that carries a face
    // and a non-string command is a 400 rather than a face update.
    const body = '{"face":"happy","command":5}';
    expect(body.includes('"command":')).toBe(true);
    expect(parseApiCommandBody(body)).toEqual({
      ok: false,
      status: 400,
      error: 'Missing command field',
    });
  });

  it('parses a face out of a body it will then reject', () => {
    // Not observable on its own — the handler returns before using it — but it
    // pins the order of operations against the source.
    expect(parseApiCommandBody('{"face":"happy","command":}')).toEqual({
      ok: false,
      status: 400,
      error: 'Missing command field',
    });
  });
});
