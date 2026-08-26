/**
 * Fetch a pinned source file — and refuse to show it if it is not the pinned one.
 *
 * ## The problem this solves
 *
 * `firmware/upstream/` is fetched by `scripts/fetch-upstream.*` and is
 * **gitignored**, so the four annotated files exist on a developer's machine
 * after that script has run and nowhere else. They are absent from a clean
 * clone, and they are not in this app's `src/`.
 *
 * Two options were on the table. Vendoring the four files into `src/generated/`
 * so they ride in git was rejected: this repository deliberately does not
 * commit upstream source (`firmware/upstream/` and `reference/` are both
 * gitignored, by an explicit decision recorded in `docs/plan.md`), and a
 * generator that quietly reversed that would be laundering 384 kB of someone
 * else's tree into this one.
 *
 * So: **bundle at build time, not at commit time** — the same shape as
 * `serveGlb()` in `vite.config.ts`, which has served `assets/sesame.glb`
 * without copying it into this package since V3. `serveUpstreamSource()` streams
 * the files in dev and `emitFile`s them into `dist/upstream/` at build. Neither
 * the repository nor `src/` gains a copy, and a built `dist/` is
 * self-contained.
 *
 * ## Why the browser hashes it anyway
 *
 * The build-time check proves what the *builder* had. It cannot prove what the
 * *browser received*: a `dist/` built against one tree and served after
 * `fetch-upstream` moved, a stale cached asset, a proxy that rewrote line
 * endings. Every one of those produces real C++ rendered at the wrong line
 * numbers — a highlight box around the wrong function, with no visible symptom.
 * That is strictly worse than an error message, so the bytes that will be
 * rendered are hashed against `meta.filesAnnotated[].sha256` **in the browser,
 * immediately before rendering**, and a mismatch renders no source at all.
 *
 * The line count is checked too, and separately. Two different failures deserve
 * two different messages: a mismatched hash with a matching line count is
 * "someone edited a line"; a mismatched count is "this is a different file".
 */
import { FILE_FACTS } from './model.js';
import { sha256Hex } from './sha256.js';
import type { SourceFileName } from '../generated/source-annotations.js';

/** Where `serveUpstreamSource()` publishes the pinned tree. */
export const UPSTREAM_URL_PREFIX = 'upstream/';

export type SourceLoad =
  | { readonly status: 'loading'; readonly file: SourceFileName }
  /** Verified. `lines[0]` is line 1. */
  | {
      readonly status: 'ok';
      readonly file: SourceFileName;
      readonly lines: readonly string[];
      readonly sha256: string;
    }
  /** `fetch-upstream` has not been run, or the build had nothing to emit. */
  | { readonly status: 'missing'; readonly file: SourceFileName; readonly url: string }
  /** The bytes are not the annotated bytes. Nothing may be rendered. */
  | {
      readonly status: 'mismatch';
      readonly file: SourceFileName;
      readonly url: string;
      readonly expectedSha256: string;
      readonly actualSha256: string;
      readonly expectedLines: number;
      readonly actualLines: number;
    }
  | { readonly status: 'error'; readonly file: SourceFileName; readonly detail: string };

/** Resolve against the document base, so `base: './'` builds work from any path. */
export function urlForSourceFile(file: SourceFileName): string {
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI;
  return new URL(`${UPSTREAM_URL_PREFIX}${file}`, base).toString();
}

/**
 * Split into lines, dropping the trailing empty element and the carriage return.
 *
 * Two normalisations, and the reasoning for each matters because getting either
 * wrong is silent.
 *
 * **The trailing element.** All four files end with a newline, and
 * `meta.filesAnnotated[].lines` is the *newline count*, so a plain
 * `split` yields one phantom line and every "the file is 1137 lines" check is
 * off by one in the direction that still looks fine.
 *
 * **Trailing whitespace.** L3 records `startLineText`, `endLineText` and every
 * citation's `text` with the line's trailing whitespace removed — 11 of the 261
 * citations differ from the raw line by exactly that, and all 261 match once it
 * is stripped. Leading whitespace is preserved on both sides, so C++
 * indentation still reads correctly. Normalising the same way here makes the
 * rendered line **identical** to the annotated text, which is what lets the
 * browser harness assert "the line numbered 91 says what L3 says line 91 says"
 * as a string equality rather than as a fuzzy comparison.
 *
 * **The carriage return.** The upstream repository stores these files with
 * **CRLF** — `git ls-files --eol` in `firmware/upstream/` reports `i/crlf
 * w/crlf`, so this is upstream's own content, not a checkout artefact of this
 * machine. `hardware/source-annotations.json` reflects that in two different
 * ways at once: `meta.filesAnnotated[].sha256` is the hash of the **CRLF
 * bytes**, while `startLineText` / `endLineText` and every citation's `text`
 * are recorded with the CR **stripped**. Both are reasonable and together they
 * pin the contract exactly:
 *
 * - **hash the bytes as received** — never normalise before hashing, or the
 *   gate stops distinguishing a CRLF tree from an LF one, which is precisely
 *   the drift `.gitattributes` exists to catch in this repository; then
 * - **compare and render the normalised line** — because that is the text the
 *   annotations recorded, and a rendered line carrying an invisible U+000D
 *   or a trailing space would never equal it.
 *
 * Neither normalisation touches the bytes that were hashed.
 */
export function splitPinnedLines(text: string): readonly string[] {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Fetch, hash, compare, and only then decode.
 *
 * @param fetchImpl injected for the unit tests, which must be able to serve a
 *   deliberately corrupted body without a browser.
 */
export async function loadPinnedSource(
  file: SourceFileName,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceLoad> {
  const facts = FILE_FACTS.get(file);
  if (facts === undefined) {
    return { status: 'error', file, detail: `${file} is not an annotated file` };
  }
  const url = urlForSourceFile(file);

  let response: Response;
  try {
    response = await fetchImpl(url, { cache: 'no-store' });
  } catch (error: unknown) {
    return {
      status: 'error',
      file,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 404) return { status: 'missing', file, url };
  if (!response.ok) {
    return { status: 'error', file, detail: `${String(response.status)} fetching ${url}` };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = sha256Hex(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = splitPinnedLines(text);

  if (actualSha256 !== facts.sha256 || lines.length !== facts.lines) {
    return {
      status: 'mismatch',
      file,
      url,
      expectedSha256: facts.sha256,
      actualSha256,
      expectedLines: facts.lines,
      actualLines: lines.length,
    };
  }

  return { status: 'ok', file, lines, sha256: actualSha256 };
}
