/**
 * The request-parsing layer, stated as assertions.
 *
 * Every case here is a behaviour of Arduino-ESP32 core **3.3.11** that a
 * client can observe through the Sesame routes. They are written as tests
 * rather than left as comments because `hardware-map.json` records the core
 * version as unresolved (`unresolved[library-versions]`) — if the pinned core
 * in `tools/arduino-data/` is ever bumped, these are the assertions that should
 * be re-derived from the new `Parsing.cpp` rather than assumed to still hold.
 */
import { describe, expect, it } from 'vitest';

import {
  ArduinoRequest,
  arduinoToInt,
  buildRequestArgs,
  classifyBody,
  parseArguments,
  urlDecode,
} from '../arduino.js';

describe('String::toInt()', () => {
  it('parses a leading integer and gives up silently', () => {
    expect(arduinoToInt('45')).toBe(45);
    expect(arduinoToInt('  -12  ')).toBe(-12);
    expect(arduinoToInt('+7')).toBe(7);
    // The one that matters: a trailing suffix does not make it invalid.
    expect(arduinoToInt('3abc')).toBe(3);
    expect(arduinoToInt('abc')).toBe(0);
    expect(arduinoToInt('')).toBe(0);
    expect(arduinoToInt('12.9')).toBe(12);
  });

  it('saturates rather than overflowing', () => {
    expect(arduinoToInt('99999999999999')).toBe(2147483647);
    expect(arduinoToInt('-99999999999999')).toBe(-2147483648);
  });
});

describe('WebServer::urlDecode()', () => {
  it('turns + into a space', () => {
    expect(urlDecode('a+b')).toBe('a b');
  });

  it('decodes %XX', () => {
    expect(urlDecode('%41%42')).toBe('AB');
    expect(urlDecode('%22')).toBe('"');
  });

  it('passes a truncated escape through literally', () => {
    // `i + 1 < len` fails with only one character left, so `%A` is not an escape.
    expect(urlDecode('x%A')).toBe('x%A');
  });

  it('truncates rather than throwing on a bad escape', () => {
    // strtol("0xG7", 16) === 0; decodeURIComponent would throw.
    expect(urlDecode('%G7')).toBe(String.fromCharCode(0));
    expect(urlDecode('%4G')).toBe(String.fromCharCode(4));
  });
});

describe('WebServer::_parseArguments()', () => {
  it('DISCARDS a token with no "=" — /cmd?stop is not a stop', () => {
    expect(parseArguments('stop')).toEqual([]);
    expect(parseArguments('stop=')).toEqual([{ key: 'stop', value: '' }]);
  });

  it('keeps going after a valueless token', () => {
    expect(parseArguments('bare&pose=wave')).toEqual([{ key: 'pose', value: 'wave' }]);
  });

  it('url-decodes both key and value', () => {
    expect(parseArguments('po%73e=wa+ve')).toEqual([{ key: 'pose', value: 'wa ve' }]);
  });

  it('runs the last value to the end of the string', () => {
    expect(parseArguments('a=1&b=2')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });
});

describe('Content-Type classification — Parsing.cpp:163-177', () => {
  it('treats an absent Content-Type as a plain body', () => {
    expect(classifyBody(undefined)).toBe('plain');
  });

  it('recognises the three cases the core distinguishes', () => {
    expect(classifyBody('application/json')).toBe('plain');
    expect(classifyBody('text/plain')).toBe('plain');
    expect(classifyBody('application/x-www-form-urlencoded')).toBe('form-urlencoded');
    expect(classifyBody('application/x-www-form-urlencoded; charset=utf-8')).toBe(
      'form-urlencoded',
    );
    expect(classifyBody('multipart/form-data; boundary=x')).toBe('multipart');
  });
});

describe('arg("plain") — the 400 that mystifies people', () => {
  const body = '{"command":"wave"}';

  it('is the whole body for a JSON content type', () => {
    const args = buildRequestArgs({
      queryString: '',
      contentType: 'application/json',
      body,
      hasBody: true,
    });
    expect(new ArduinoRequest('/api/command', 'POST', args).arg('plain')).toBe(body);
  });

  it('is EMPTY for a form-urlencoded content type', () => {
    const args = buildRequestArgs({
      queryString: '',
      contentType: 'application/x-www-form-urlencoded',
      body,
      hasBody: true,
    });
    // Parsing.cpp:217-231 — an encoded body is folded into the argument list
    // and `plain` is never created. The handler then reports a missing command.
    expect(new ArduinoRequest('/api/command', 'POST', args).arg('plain')).toBe('');
  });

  it('lets a form-urlencoded body supply named args, after the query string', () => {
    const args = buildRequestArgs({
      queryString: 'ssid=fromQuery',
      contentType: 'application/x-www-form-urlencoded',
      body: 'ssid=fromBody&password=p',
      hasBody: true,
    });
    const req = new ArduinoRequest('/api/wifi/connect', 'POST', args);
    // The query is concatenated first and arg() returns the first match.
    expect(req.arg('ssid')).toBe('fromQuery');
    expect(req.arg('password')).toBe('p');
  });

  it('lets ?plain= in the URL shadow the request body', () => {
    const args = buildRequestArgs({
      queryString: 'plain=fromQuery',
      contentType: 'application/json',
      body,
      hasBody: true,
    });
    expect(new ArduinoRequest('/api/command', 'POST', args).arg('plain')).toBe('fromQuery');
  });

  it('parses only the URL when there is no body', () => {
    const args = buildRequestArgs({
      queryString: 'pose=wave',
      contentType: undefined,
      body: '',
      hasBody: false,
    });
    const req = new ArduinoRequest('/cmd', 'GET', args);
    expect(req.hasArg('pose')).toBe(true);
    expect(req.hasArg('plain')).toBe(false);
  });
});
