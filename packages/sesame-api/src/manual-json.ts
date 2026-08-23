/**
 * `handleApiCommand()`'s body parser — `firmware/sesame-firmware-main.ino:315`–`:362`.
 *
 * The firmware links no JSON library. It scans `server.arg("plain")` with
 * `indexOf` and `substring` and nothing else, and the result is a parser with
 * an acceptance set that no JSON grammar describes. Since external tools are
 * meant to point at either the robot or this adapter without changing
 * anything, the acceptance set is part of the contract and is reproduced
 * statement for statement below.
 *
 * The non-obvious consequences, all reachable over the network and all
 * asserted in `api-command.test.ts`:
 *
 * | Body | Upstream result | Why |
 * |---|---|---|
 * | `"face":"rest"` (no braces) | 400 Missing command field | `faceOnlyStart > 0` is a strict `>`; a match at index 0 reads as "not found" (`:329`) |
 * | `{"command" : "wave"}` | 400 Missing command field | only `"command":"` and `"command": "` are searched (`:338`–`:341`) |
 * | `{"face":"happy","echo":"\"command\":x"}` | 400 Missing command field | the `faceOnly` test greps the **whole body** for `"command":`, escaped occurrences included, so this is not face-only (`:329`) — and then the stricter `"command":"` scan finds nothing |
 * | `{"command":"wave","face":"happy"}` | face set, then `wave` runs | both fields are honoured; only the *absence* of `"command":` makes it face-only |
 * | `{"command":""}` | 400 Invalid command format | `cmdEnd <= cmdStart` (`:352`) |
 * | `{"face":""}` | 200 "Face updated", no `setFace()` | `faceEnd > faceOnlyStart` fails so `face` stays empty, and `:365` guards on length |
 * | `{"command":"wa\"ve"}` | command is `wa\` | there is no escape handling; the scan stops at the first `"` |
 * | `[{"command":"wave"}]` | `wave` runs | nothing requires the body to be an object |
 * | `garbage{"command":"wave"}trailing` | `wave` runs | nothing requires the body to be JSON at all |
 *
 * Nothing here is "fixed". A stricter parser would reject bodies the robot
 * accepts, which is precisely the compatibility this package exists to provide.
 */

/** What the firmware's scanner extracted, or the 400 it produced. */
export type ApiCommandParse =
  | {
      readonly ok: true;
      /** A face was found and no `"command":` appears anywhere in the body. */
      readonly faceOnly: boolean;
      /** Empty when no face was extracted. */
      readonly face: string;
      /** Empty when `faceOnly`. */
      readonly command: string;
    }
  | {
      readonly ok: false;
      readonly status: 400;
      /** Verbatim upstream error strings — `:346` and `:355`. */
      readonly error: 'Missing command field' | 'Invalid command format';
    };

/**
 * Transliteration of `handleApiCommand()`'s parsing block. Deliberately keeps
 * the firmware's variable names and control flow so the two can be diffed by
 * eye against `sesame-firmware-main.ino:315`–`:362`.
 */
export function parseApiCommandBody(body: string): ApiCommandParse {
  // :316-:320
  let faceOnlyStart = body.indexOf('"face":"');
  if (faceOnlyStart === -1) {
    faceOnlyStart = body.indexOf('"face": "');
  }

  // :323 — note the strict `> 0`, and that the second indexOf is a subset of
  // the first, so it can never change the outcome.
  const faceOnly =
    faceOnlyStart > 0 && body.indexOf('"command":') === -1 && body.indexOf('"command": ') === -1;

  let command = '';
  let face = '';

  // :328-:336
  if (faceOnlyStart > 0) {
    faceOnlyStart = body.indexOf('"', faceOnlyStart + 6) + 1;
    const faceEnd = body.indexOf('"', faceOnlyStart);
    if (faceEnd > faceOnlyStart) {
      face = body.substring(faceOnlyStart, faceEnd);
    }
  }

  // :338-:361
  if (!faceOnly) {
    let cmdStart = body.indexOf('"command":"');
    if (cmdStart === -1) {
      cmdStart = body.indexOf('"command": "');
    }
    if (cmdStart === -1) {
      return { ok: false, status: 400, error: 'Missing command field' };
    }
    cmdStart = body.indexOf('"', cmdStart + 10) + 1;
    const cmdEnd = body.indexOf('"', cmdStart);
    if (cmdEnd <= cmdStart) {
      return { ok: false, status: 400, error: 'Invalid command format' };
    }
    command = body.substring(cmdStart, cmdEnd);
  }

  return { ok: true, faceOnly, face, command };
}
