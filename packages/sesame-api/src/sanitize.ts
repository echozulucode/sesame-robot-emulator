/**
 * The boundary. Everything that arrives over HTTP and can end up in a face
 * name, a command word, a telemetry line or a JSON response passes through
 * here first.
 *
 * ## Why this file exists
 *
 * Phase 0 found this class of bug once already. `@SESAME` telemetry is a line
 * protocol whose parser scans for the sentinel at **any** offset
 * (`docs/protocol/sesame-telemetry-v1.md` §3.2), and face names reach the
 * emitter straight from user input: `POST /api/command` carries a `face` field
 * and `setFace()` stores whatever it was handed even when the table lookup
 * misses (`firmware/sesame-firmware-main.ino:906`). A name containing a space
 * breaks the token split; a name containing `@SESAME ` forges a second segment.
 * R6's fix was `sesameSafeToken()` in the firmware patch
 * (`firmware/patches/telemetry-instrumentation.patch:105`–`:116`); see
 * `docs/findings/R6-R7-telemetry-bridge.md` §"A hardening decision that was not
 * optional".
 *
 * This adapter sits in front of backends that are **not** the patched firmware
 * — `SimulatedSesameRobot` today, a QEMU-backed or physical robot later — so
 * the same guarantee has to be re-established at this boundary rather than
 * assumed from the one below it.
 *
 * ## The second reason, which is upstream's and not ours
 *
 * `handleGetStatus()` (`:289`) builds its JSON by string concatenation and
 * **does not escape** `currentCommand` or `currentFaceName`:
 *
 * ```c
 * json += "\"currentCommand\":\"" + currentCommand + "\",";
 * ```
 *
 * `currentCommand` is assignable from the network — `GET /cmd?pose=%22` sets it
 * to a bare double quote, because `WebServer::urlDecode()` runs before the
 * handler sees it. The next `GET /api/status` then emits syntactically invalid
 * JSON, and with a longer payload, attacker-chosen keys. Upstream escapes SSIDs
 * with `jsonEscape()` (`:389`) and does not apply it here.
 *
 * **This is the one upstream behaviour this package deliberately does not
 * reproduce, and there is no option to turn the divergence off.** Emitting
 * forged sentinels or attacker-controlled JSON is not a compatibility feature.
 * The divergence is invisible for every legal input: a name drawn from the
 * firmware's own vocabulary is already `[A-Za-z0-9_.-]`, so sanitised output is
 * byte-identical to upstream's. See `docs/findings/V5-api-adapter.md` §6.
 */

/**
 * `char safe[24]` in the R6 patch (`telemetry-instrumentation.patch:129`),
 * i.e. 23 characters plus the NUL. Matching it here means a name that survives
 * this boundary also survives the firmware's, so the two cannot disagree about
 * what a truncated name looks like.
 */
export const SAFE_TOKEN_MAX_LENGTH = 23;

/**
 * `sesameSafeToken()` — `firmware/patches/telemetry-instrumentation.patch:105`.
 *
 * Reduce a name to `[A-Za-z0-9_.-]`, substituting `_` for everything else,
 * truncate to {@link SAFE_TOKEN_MAX_LENGTH}, and never return the empty string.
 * Character-for-character the same rule as the firmware's, including the
 * `_`-for-empty fallback at `:114`.
 *
 * Note what the class excludes and why: **space** (breaks the wire protocol's
 * token split), **`@`** (the sentinel's first byte), **`"` and `\`** (JSON
 * string escape), **`<`** (HTML), and every control character (line splitting).
 */
export function sesameSafeToken(input: string): string {
  let out = '';
  for (const ch of input) {
    if (out.length >= SAFE_TOKEN_MAX_LENGTH) break;
    const ok =
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' ||
      ch === '-' ||
      ch === '.';
    out += ok ? ch : '_';
  }
  if (out.length === 0) out = '_';
  return out;
}

/** True when `sesameSafeToken` would leave the input untouched. */
export function isSafeToken(input: string): boolean {
  return input.length > 0 && sesameSafeToken(input) === input;
}

/**
 * `jsonEscape()` — `firmware/sesame-firmware-main.ino:390`.
 *
 * Backslash, double quote, and `\u00xx` for anything below 0x20. Upstream
 * applies it to SSIDs and to `lastError`; this package applies it to every
 * string it emits, which for sanitised tokens is a no-op.
 */
export function jsonEscape(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

/** `"…"` with {@link jsonEscape} applied. */
export function jsonString(value: string): string {
  return `"${jsonEscape(value)}"`;
}

/**
 * Escape text for interpolation into the stub portal HTML.
 *
 * Upstream never interpolates anything into `index_html` — it is one static
 * PROGMEM literal — so this is ours, guarding the one thing the stub echoes
 * back (nothing, today; the helper exists so that adding an echo cannot
 * introduce an injection by omission).
 */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
