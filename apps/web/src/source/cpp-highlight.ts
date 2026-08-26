/**
 * Just enough C++ colouring to read Sesame's firmware.
 *
 * ## Why not a real highlighter
 *
 * `highlight.js` with only the C++ grammar is ~90 kB minified; `shiki` ships a
 * TextMate engine and a theme and lands in the hundreds. Either would be the
 * largest single thing in this app after three.js, and would be carrying a
 * general-purpose language stack to render four files of one language whose
 * *semantic* structure is already known — the annotations say which span is a
 * function, which lines are cited, what the symbol does. Colour here is
 * legibility, not analysis, so the trade is 120 lines against a dependency and
 * a lockfile change. No new package was added for this feature.
 *
 * ## What it does and does not do
 *
 * It is a scanner, not a parser. It gets comments, strings, character
 * literals, preprocessor directives, numbers, keywords and types right, which
 * is the whole difference between readable and unreadable. It does not know
 * scopes, does not resolve types, and deliberately does not try: a wrong
 * colour on `String` is harmless, and there is no claim anywhere in the UI that
 * rests on it.
 *
 * ## Multi-line state
 *
 * A block comment and a raw string literal both span lines, and
 * `captive-portal.h` is a **1007-line raw string** — so a per-line scanner with
 * no carry-over would colour the entire captive portal UI as C++ keywords.
 * {@link highlightCppLines} therefore threads a small state across lines and is
 * always called on a whole window at once, never on one line in isolation.
 */

export type CppTokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'preproc'
  | 'number'
  | 'keyword'
  | 'type';

export interface CppToken {
  readonly kind: CppTokenKind;
  readonly text: string;
}

/** Control flow and declaration keywords. Colour group 1. */
const KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'break', 'case', 'catch', 'class', 'const', 'constexpr',
  'continue', 'default', 'delete', 'do', 'else', 'enum', 'explicit', 'extern', 'false',
  'for', 'friend', 'goto', 'if', 'inline', 'namespace', 'new', 'not', 'nullptr', 'operator',
  'or', 'private', 'protected', 'public', 'register', 'return', 'sizeof', 'static',
  'static_cast', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef',
  'typename', 'union', 'using', 'virtual', 'volatile', 'while',
]);

/**
 * Types, including the Arduino/ESP32 spellings that dominate this firmware.
 *
 * `PROGMEM`, `String`, `uint8_t` and friends are what a learner is actually
 * looking at in these four files; leaving them plain would make the type
 * colour almost never fire.
 */
const TYPES = new Set([
  'auto', 'bool', 'byte', 'char', 'double', 'float', 'int', 'int8_t', 'int16_t', 'int32_t',
  'int64_t', 'long', 'short', 'signed', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t',
  'uint64_t', 'unsigned', 'void', 'wchar_t',
  'String', 'PROGMEM', 'IPAddress', 'WebServer', 'DNSServer', 'Servo', 'Adafruit_SSD1306',
]);

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/**
 * Scanner state that survives a line break.
 *
 * `rawDelimiter` is the `R"delim(` marker: the literal ends at `)delim"` and at
 * nothing else, which is exactly why `index_html`'s 1007 lines of HTML and
 * JavaScript do not confuse anything.
 */
export interface CppScanState {
  readonly inBlockComment: boolean;
  readonly rawDelimiter: string | null;
}

export const CPP_INITIAL_STATE: CppScanState = Object.freeze({
  inBlockComment: false,
  rawDelimiter: null,
});

interface LineResult {
  readonly tokens: readonly CppToken[];
  readonly state: CppScanState;
}

function scanLine(line: string, incoming: CppScanState): LineResult {
  const tokens: CppToken[] = [];
  let state = incoming;
  let i = 0;
  let plain = '';

  const flush = (): void => {
    if (plain.length > 0) {
      tokens.push({ kind: 'plain', text: plain });
      plain = '';
    }
  };
  const push = (kind: CppTokenKind, text: string): void => {
    flush();
    tokens.push({ kind, text });
  };

  // --------------------------------------------------- carried-over states
  if (state.rawDelimiter !== null) {
    const close = `)${state.rawDelimiter}"`;
    const at = line.indexOf(close);
    if (at < 0) return { tokens: [{ kind: 'string', text: line }], state };
    push('string', line.slice(0, at + close.length));
    state = { ...state, rawDelimiter: null };
    i = at + close.length;
  } else if (state.inBlockComment) {
    const at = line.indexOf('*/');
    if (at < 0) return { tokens: [{ kind: 'comment', text: line }], state };
    push('comment', line.slice(0, at + 2));
    state = { ...state, inBlockComment: false };
    i = at + 2;
  }

  // A `#` in the first non-blank column makes the whole line a directive.
  if (i === 0 && /^\s*#/.test(line)) {
    return { tokens: [{ kind: 'preproc', text: line }], state };
  }

  while (i < line.length) {
    const c = line[i] as string;
    const next = line[i + 1] ?? '';

    if (c === '/' && next === '/') {
      push('comment', line.slice(i));
      i = line.length;
      continue;
    }
    if (c === '/' && next === '*') {
      const at = line.indexOf('*/', i + 2);
      if (at < 0) {
        push('comment', line.slice(i));
        state = { ...state, inBlockComment: true };
        i = line.length;
      } else {
        push('comment', line.slice(i, at + 2));
        i = at + 2;
      }
      continue;
    }
    // Raw string: R"delim( … )delim"
    if (c === 'R' && next === '"') {
      const open = /^R"([^(\s\\]*)\(/.exec(line.slice(i));
      if (open !== null) {
        const delimiter = open[1] ?? '';
        const close = `)${delimiter}"`;
        const at = line.indexOf(close, i + open[0].length);
        if (at < 0) {
          push('string', line.slice(i));
          state = { ...state, rawDelimiter: delimiter };
          i = line.length;
        } else {
          push('string', line.slice(i, at + close.length));
          i = at + close.length;
        }
        continue;
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') j += 2;
        else if (line[j] === c) {
          j += 1;
          break;
        } else j += 1;
      }
      push('string', line.slice(i, Math.min(j, line.length)));
      i = Math.min(j, line.length);
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(next))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXbBoO._']/.test(line[j] as string)) j += 1;
      push('number', line.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < line.length && isIdent(line[j] as string)) j += 1;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) push('keyword', word);
      else if (TYPES.has(word)) push('type', word);
      else plain += word;
      i = j;
      continue;
    }
    plain += c;
    i += 1;
  }

  flush();
  return { tokens, state };
}

/**
 * Highlight a contiguous window of lines.
 *
 * @param lines the window, in file order.
 * @param initial the scanner state at the FIRST line of the window. When a
 *   window starts inside a block comment or inside `index_html`'s raw string,
 *   pass the state produced by scanning from the top of the file — or accept
 *   that the first few lines may be mis-coloured, which is a cosmetic error and
 *   never a factual one.
 */
export function highlightCppLines(
  lines: readonly string[],
  initial: CppScanState = CPP_INITIAL_STATE,
): readonly (readonly CppToken[])[] {
  const out: (readonly CppToken[])[] = [];
  let state = initial;
  for (const line of lines) {
    const result = scanLine(line, state);
    out.push(result.tokens);
    state = result.state;
  }
  return out;
}

/**
 * The scanner state at `line` (1-based), by scanning everything above it.
 *
 * Cheap enough to run on window changes — the largest file is 3158 lines of
 * hex — and it is the difference between the middle of `index_html` rendering
 * as a string and rendering as a keyword soup.
 */
export function scanStateAt(allLines: readonly string[], line: number): CppScanState {
  let state = CPP_INITIAL_STATE;
  const stop = Math.min(line - 1, allLines.length);
  for (let i = 0; i < stop; i++) state = scanLine(allLines[i] ?? '', state).state;
  return state;
}
