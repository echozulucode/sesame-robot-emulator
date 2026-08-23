/**
 * The bits of Arduino that are part of the observable HTTP contract.
 *
 * The Sesame handlers are three hundred lines of `server.hasArg()`,
 * `server.arg()` and `String::toInt()`. None of those mean what a Node
 * developer would assume, and the differences are reachable from the network —
 * `GET /cmd?stop` (no `=`) is a **400**, not a stop. So the adapter reproduces
 * the request-parsing layer rather than the handlers alone, and every rule here
 * cites the core it came from.
 *
 * Provenance: Arduino-ESP32 core **3.3.11**, the version F3 builds with, vendored
 * in this repo at
 * `tools/arduino-data/data/packages/esp32/hardware/esp32/3.3.11/libraries/WebServer/src/`.
 * Line references below are to `Parsing.cpp` and `WebServer.cpp` in that tree.
 * `hardware-map.json` records the core version as unresolved
 * (`unresolved[library-versions]`); this module is pinned to what is on disk,
 * and `arduino-parsing.test.ts` states each rule as an assertion so a core bump
 * is a test failure rather than a silent behaviour change.
 */

/** One `WebServer::RequestArgument`. */
export interface RequestArg {
  readonly key: string;
  readonly value: string;
}

/**
 * `String::toInt()` — `atol()` under the hood, i.e. `strtol(buf, nullptr, 10)`.
 *
 * Leading whitespace is skipped, an optional sign is accepted, digits are
 * consumed until the first non-digit, and **anything unparseable is `0`**.
 * `"3abc"` is `3`; `"abc"` is `0`; `""` is `0`. Saturates at the `long`
 * boundaries the way `strtol` does, which on this target is 32-bit.
 *
 * This is why `GET /cmd?motor=abc&value=50` is a 400 (`motorNum` 0, no name
 * match) but `GET /cmd?motor=3abc&value=50` moves channel 3.
 */
export function arduinoToInt(value: string): number {
  const match = /^\s*[+-]?\d+/.exec(value);
  if (match === null) return 0;
  const n = Number(match[0].trim());
  if (n > 2147483647) return 2147483647;
  if (n < -2147483648) return -2147483648;
  return n;
}

const HEX = '0123456789abcdef';

function hexDigit(ch: string): number {
  const i = HEX.indexOf(ch.toLowerCase());
  return i;
}

/**
 * `WebServer::urlDecode()` — `Parsing.cpp:urlDecode`.
 *
 * Three behaviours that differ from `decodeURIComponent`:
 *
 * 1. `+` becomes a space.
 * 2. A `%` escape is only consumed when **two** more characters remain
 *    (`i + 1 < len`), so a trailing `%A` is passed through literally.
 * 3. The two characters are handed to `strtol("0xAB", nullptr, 16)`, so a
 *    non-hex digit does not raise — it truncates. `%G7` decodes to `\0`,
 *    `%4G` decodes to `\x04`. `decodeURIComponent` would throw on both.
 */
export function urlDecode(text: string): string {
  let decoded = '';
  const len = text.length;
  let i = 0;
  while (i < len) {
    const encodedChar = text.charAt(i++);
    if (encodedChar === '%' && i + 1 < len) {
      const c1 = text.charAt(i++);
      const c2 = text.charAt(i++);
      const d1 = hexDigit(c1);
      const d2 = hexDigit(c2);
      // strtol("0x" + c1 + c2, 16): stops at the first non-hex character.
      const code = d1 < 0 ? 0 : d2 < 0 ? d1 : d1 * 16 + d2;
      decoded += String.fromCharCode(code);
    } else if (encodedChar === '+') {
      decoded += ' ';
    } else {
      decoded += encodedChar;
    }
  }
  return decoded;
}

/**
 * `WebServer::_parseArguments()` — `Parsing.cpp:305`.
 *
 * The rule that matters: **a token with no `=` is discarded**, not stored with
 * an empty value (`:335`–`:342`). `?stop` therefore does not exist as an
 * argument and `hasArg("stop")` is false; `?stop=` does exist, with the empty
 * string as its value.
 *
 * Keys and values are both url-decoded (`:344`–`:345`), and a trailing argument
 * runs to the end of the string.
 */
export function parseArguments(data: string): RequestArg[] {
  const args: RequestArg[] = [];
  if (data.length === 0) return args;

  let pos = 0;
  for (;;) {
    const equalSignIndex = data.indexOf('=', pos);
    const nextArgIndex = data.indexOf('&', pos);
    if (equalSignIndex === -1 || (equalSignIndex > nextArgIndex && nextArgIndex !== -1)) {
      // "arg missing value" — dropped entirely.
      if (nextArgIndex === -1) break;
      pos = nextArgIndex + 1;
      continue;
    }
    const end = nextArgIndex === -1 ? data.length : nextArgIndex;
    args.push({
      key: urlDecode(data.slice(pos, equalSignIndex)),
      value: urlDecode(data.slice(equalSignIndex + 1, end)),
    });
    if (nextArgIndex === -1) break;
    pos = nextArgIndex + 1;
  }
  return args;
}

/** How `Parsing.cpp:163`–`:177` classifies a request body from its Content-Type. */
export type BodyKind = 'form-urlencoded' | 'multipart' | 'plain';

/** `Parsing.cpp:163`–`:177`. Note that *no* Content-Type header lands on `plain`. */
export function classifyBody(contentType: string | undefined): BodyKind {
  const value = contentType ?? '';
  if (value.startsWith('application/x-www-form-urlencoded')) return 'form-urlencoded';
  if (value.startsWith('multipart/')) return 'multipart';
  return 'plain';
}

/**
 * Build the argument list a Sesame handler would see, following
 * `Parsing.cpp:210`–`:242` exactly.
 *
 * The consequential branch, and the reason this function exists:
 *
 * | Content-Type | `arg("plain")` | body parsed as args? |
 * |---|---|---|
 * | `application/json`, `text/plain`, **absent** | the whole body | no |
 * | `application/x-www-form-urlencoded` | **empty** | yes, appended after the query |
 * | `multipart/*` | empty | as form fields |
 *
 * So `POST /api/command` with a perfectly good JSON body and a
 * `Content-Type: application/x-www-form-urlencoded` header gets
 * `400 {"error":"Missing command field"}` — the handler reads `arg("plain")`
 * and there is nothing there. That is upstream behaviour, reproduced.
 *
 * Also note the ordering: the query string is parsed *first*, and `arg()`
 * returns the **first** match (`WebServer.cpp:arg`), so a `?plain=…` in the URL
 * shadows the request body.
 */
export function buildRequestArgs(input: {
  readonly queryString: string;
  readonly contentType: string | undefined;
  readonly body: string;
  readonly hasBody: boolean;
}): RequestArg[] {
  const kind = classifyBody(input.contentType);
  if (!input.hasBody || input.body.length === 0) {
    // "No content - but we can still have arguments in the URL." Parsing.cpp:246
    return parseArguments(input.queryString);
  }
  if (kind === 'form-urlencoded') {
    const search =
      input.queryString === '' ? input.body : `${input.queryString}&${input.body}`;
    return parseArguments(search);
  }
  if (kind === 'multipart') {
    // The Sesame firmware registers no upload handlers, so a multipart body
    // contributes form fields we cannot usefully model and never sets `plain`.
    return parseArguments(input.queryString);
  }
  return [...parseArguments(input.queryString), { key: 'plain', value: input.body }];
}

/**
 * The handler-visible view of one request: `server.uri()`, `server.method()`,
 * `server.hasArg()`, `server.arg()`.
 */
export class ArduinoRequest {
  constructor(
    /** `server.uri()` — the path, query string removed. */
    readonly uri: string,
    /** `server.method()`, upper-case. */
    readonly method: string,
    private readonly args: readonly RequestArg[],
  ) {}

  /** `WebServer::hasArg` — `WebServer.cpp`. */
  hasArg(name: string): boolean {
    return this.args.some((a) => a.key === name);
  }

  /** `WebServer::arg` — first match wins, `""` when absent. */
  arg(name: string): string {
    return this.args.find((a) => a.key === name)?.value ?? '';
  }

  /** All arguments, in the order the core stored them. Diagnostics only. */
  allArgs(): readonly RequestArg[] {
    return this.args;
  }
}
