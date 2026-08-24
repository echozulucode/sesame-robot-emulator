# Sesame Telemetry Protocol — `@SESAME` v1

**Status:** implemented · **Task:** R5 (Phase 0, Workstream R) · **Date:** 2026-08-23
**Extended by:** `sesame-telemetry-v2.md` (host → device direction, and the `origin` field). Everything below is still current; v2 changes nothing on the device → host wire and does not bump `@SESAME hello`.
**Reference implementation:** `packages/sesame-protocol` (`@sesame-lab/sesame-protocol`)
**Audience:** anyone writing an emitter (C++ on ESP32, a Python replay harness, a host-side
behaviour model) or a consumer (the bridge, the debug viewer, the Phase-1 frontend).

This document is self-contained. You should not need to read the TypeScript to implement either
side of it.

---

## 1. What this protocol is for

One typed event stream that three different backends can produce and one frontend can consume:

```text
instrumented firmware ──┐
host behaviour model ───┼──► SesameTelemetry ──► bridge ──► WebSocket ──► browser
Renode emulated UART ───┘
```

The wire format exists because the first and third of those speak a **UART byte stream**, and a
byte stream needs framing. Everything about the design is a consequence of two facts:

1. The emitter is a `Serial.printf` inside `setServoAngle()`, which runs on an ESP32-S2 inside a
   20 ms `motorCurrentDelay` budget. **Brevity beats elegance.** No JSON, no escaping, no
   per-event allocation.
2. The receiver reads a socket. Lines arrive split at arbitrary offsets, interleaved with ordinary
   `Serial.println` boot logging, and — per `docs/findings/R1-renode-capability-audit.md` §5.4 —
   possibly with telnet IAC negotiation bytes spliced in if anyone forgets `telnetMode: false`.
   **The parser must be defensive and must never lose the surrounding log text.**

---

## 2. Transport

| Property | Value |
|---|---|
| Encoding | UTF-8. In practice ASCII; emitters SHOULD stay in `0x20`–`0x7E`. |
| Framing | Line-oriented. `LF` (`0x0A`), `CRLF` (`0x0D 0x0A`) and lone `CR` (`0x0D`) are all accepted terminators. Emitters SHOULD use `LF`. |
| Direction | Device → host only. v1 defines no host → device messages. **Superseded by v2**, which adds the host → device direction over the same UART0 using the firmware's own serial console — see `sesame-telemetry-v2.md` §2. The device → host wire below is unchanged by v2. |
| Multiplexing | The telemetry stream shares UART0 with ordinary firmware logging. That is a feature: the log text is a telemetry channel (`log` events on channel `uart`). |
| Renode setup | `emulation CreateServerSocketTerminal <port> "term" false` then `connector Connect uart0 term`. The third argument is `telnetMode` and **must** be `false`. |

Line length: an emitter MUST NOT emit a line longer than the receiver's cap. The reference
implementation defaults to **65536 bytes**; the longest line v1 can produce is the `oled` line at
**1385 bytes**.

---

## 3. Grammar

```abnf
stream       = *( line terminator ) [ line ]
terminator   = LF / CR LF / CR

line         = [ prefix ] *segment
prefix       = <any text not containing the sentinel>      ; becomes a `log` event
segment      = sentinel SP verb *( SP tag ) *( SP arg ) [ SP freetext ]

sentinel     = "@SESAME"                                   ; must be followed by SP/HTAB or EOL
verb         = 1*( ALPHA / DIGIT / "_" / "." / "-" )
tag          = key "=" value
key          = ALPHA *( ALPHA / DIGIT / "_" )
value        = *( %x21-7E except SP )
arg          = 1*( %x21-7E except SP )
freetext     = <rest of the line, verbatim>                ; `log` verb only
SP           = %x20 / %x09
```

### 3.1 Tags come **before** the positional arguments

This is the one structural decision worth stating loudly, because it looks backwards:

```text
@SESAME servo t=91234 x=wave-0042 R4 72
        ^verb ^-------tags-------^ ^args
```

Reason: the `log` verb ends in a free-text field. If tags were trailing, a message body ending in
`foo=bar` would be indistinguishable from a tag. With tags leading, the parser stops consuming
tags at the first token that is not `key=value`, and for `log` that token is always the channel —
so nothing in a message body can ever be misread as metadata.

The common case pays nothing for this: with no tags, the line is exactly what you would have
written anyway.

```text
@SESAME servo R4 72
@SESAME face wave 0
```

### 3.2 The sentinel is matched anywhere in the line

A receiver MUST scan for `@SESAME` (followed by whitespace or end-of-line) at **any** offset, not
only at column 0, and MUST split the line at every such occurrence.

- Text before the first sentinel becomes a `log` event on channel `uart`.
- Each sentinel begins a new segment, which ends at the next sentinel or at end of line.

This exists because two `Serial.printf` calls with no newline between them really do produce
`...R4 72@SESAME face wave 0`, and because a firmware that prefixes its output
(`[servo] @SESAME servo R4 72`) must still work.

**Consequence, and the one real wart in v1:** a `log` message body containing `@SESAME ` will be
re-split on parse. Emitters MUST NOT embed the sentinel in a message body.

### 3.3 Whitespace

Runs of spaces and tabs separate tokens. Leading and trailing whitespace on a line is stripped.
Inside a `log` free-text field, internal whitespace is preserved verbatim.

---

## 4. Tags

Every tag is optional. Unknown tags MUST be ignored (with a warning), never rejected.

| Key | Field | Format | Notes |
|---|---|---|---|
| `s` | `seq` | unsigned decimal integer | Overrides the receiver's counter. Omit it and let the receiver number the stream — that is one less variable the firmware has to keep. |
| `t` | `simTimeUs` | unsigned decimal integer | Emulator virtual time in microseconds. Renode has one; a physical robot does not. Present only when the value is real; never synthesise it from `millis()` and call it virtual time. |
| `p` | `provenance` | `o` \| `s` \| `i` | Also accepts the long spellings `observed` / `simulated` / `inferred`. Absent means the receiver's configured default. |
| `x` | `traceId` | token, no whitespace | Causal-trace id. See §7. |

---

## 5. Verbs

### 5.1 `servo` → `servo.target`

```text
@SESAME servo <joint> <angleDeg>
@SESAME servo R4 72
```

| Field | Rule |
|---|---|
| `joint` | Exactly one of `R1 R2 L1 L2 R4 R3 L3 L4`. Case-sensitive. This is the firmware enum order from `firmware/movement-sequences.h:5`; `R4` really does come before `R3`. Anything else → `protocol.unknown` / `unknown-joint`. |
| `angleDeg` | Decimal, optionally signed, optionally fractional. Firmware emits integers. Valid range is the firmware clamp **0–180** (`constrain(angle + servoSubtrim[channel], 0, 180)`, `firmware/sesame-firmware-main.ino:1053`). |

The angle is the **post-subtrim, post-clamp** value — what actually reached `Servo::write()`. Emit
from the single convergence point in `setServoAngle()`, after the clamp, not from each movement
function.

Out-of-range angles are **flagged, not clamped**: the event is still emitted, carrying an
`angle-out-of-range` warning. Silently clamping on the receive side would hide the bug that
produced the bad value.

### 5.2 `face` → `face.expression`

```text
@SESAME face <name> [<frame>]
@SESAME face wave 0
@SESAME face happy
```

| Field | Rule |
|---|---|
| `name` | Expression name as the firmware spells it. Validated against the 38 faces in `hardware/hardware-map.json`, but an unknown name is a **warning with passthrough**, never an error — firmware can add faces and the protocol must not need a release to keep up. `setFace()` is case-insensitive (`firmware/sesame-firmware-main.ino:917`), so a case-only mismatch is warned separately. |
| `frame` | Optional. Non-negative integer, 0-based. `MAX_FACE_FRAMES` is 6. A frame past the face's known frame count is warned, not rejected. |

Note the firmware ships both `defualt` and `default` as face names. That is not a typo in this
document.

### 5.3 `oled` → `oled.frame`

```text
@SESAME oled <encoding> <payload>
@SESAME oled b64 AAAAAAAA…            (1368 payload characters)
```

`encoding` is `b64` in v1. The `encoding` token exists so v2 can add a compressed form without a
new verb. See §6 for the pixel layout.

### 5.4 `log` → `log`

```text
@SESAME log <channel> <text…>
@SESAME log firmware entering runWavePose
@SESAME log uart
```

`channel` is `uart`, `firmware`, or `emulator`. `text` is the rest of the line, verbatim, and may
be empty. No escaping: the line terminator is the only delimiter, so the only characters a body
cannot contain are `CR`, `LF`, and the sentinel (§3.2).

Non-`@SESAME` stream text also becomes a `log` event, on channel `uart`, with the line trimmed.

### 5.5 `hello` → `protocol.hello`

```text
@SESAME hello <protocolVersion> [<emitter>]
@SESAME hello 1 sesame-fw-s2mini/0.1.0
```

Emitters SHOULD send this once, as early as `Serial` is usable. A receiver that sees a version
newer than it implements warns and keeps going — it does not disconnect.

### 5.6 Anything else → `protocol.unknown`

An unrecognised verb, or a recognised verb with unusable arguments, produces a
`protocol.unknown` event carrying the **raw line verbatim**. A receiver MUST NOT throw and MUST
NOT silently discard the line. Re-serialising a `protocol.unknown` reproduces the original bytes
exactly, so a bridge can forward a line it does not understand without corrupting it.

---

## 6. OLED pixel encoding

The panel is an SSD1306 128×64 at I²C `0x3C`, driven by `Adafruit_SSD1306`.

**The buffer is page-ordered, not row-ordered.** From `Adafruit_SSD1306::drawPixel`:

```c
buffer[x + (y / 8) * WIDTH] |= (1 << (y & 7));
```

v1 adopts that byte-for-byte, so the firmware emitter is a base64 of `display.getBuffer()` with
**zero transformation** — no transpose, no bit reversal, no 1 KB scratch buffer on a device that
does not have one to spare.

| Property | Value |
|---|---|
| Buffer length | exactly **1024 bytes** (128 columns × 8 pages) |
| Byte index | `index = x + page * 128`, where `page = y >> 3` |
| Bit within byte | `bit = y & 7`, counted **from the LSB**. Bit 0 is the *top* row of the page; bit 7 is the bottom row. |
| Bit value | `1` = lit (white), `0` = dark |
| Byte order on the wire | buffer order: page 0 columns 0…127, then page 1 columns 0…127, … page 7 |
| Wire encoding | standard RFC 4648 base64, alphabet `A–Za–z0–9+/`, `=` padding → exactly **1368 characters** |

Worked example: pixel `(x=3, y=9)` is page 1, byte index `3 + 1*128 = 131`, bit 1 →
`buffer[131] & 0x02`.

> **This is not the layout of the face bitmaps in `firmware/face-bitmaps.h`.** Those are
> horizontal-scan (row-major, MSB-first) arrays fed to `Adafruit_GFX::drawBitmap`, which converts
> them into the page layout on the way in. `oled.frame` is what reaches the glass, not what was
> authored.

Decoder in Python:

```python
import base64
buf = base64.b64decode(payload)          # 1024 bytes
assert len(buf) == 1024
def pixel(x, y):
    return (buf[x + (y >> 3) * 128] >> (y & 7)) & 1
```

---

## 7. Provenance and trace IDs

### 7.1 `provenance` is required on every event

Not on the wire — on the wire it defaults — but **in the decoded event type**. The research
report's "See the Signal" section requires the UI to distinguish three things, and making the tag
a required field means teaching fidelity is machine-checked rather than a convention someone
forgets in a `<div>`.

| Value | Wire | Meaning | May be presented as fact? |
|---|---|---|---|
| `observed` | `p=o` | Something actually happened on the other side of a real boundary: bytes crossed the emulated UART, the firmware hook really ran, the physical robot really moved. | yes |
| `simulated` | `p=s` | A host-side behaviour model computed what the robot *would* do. No firmware, no silicon. | only when labelled |
| `inferred` | `p=i` | Constructed for explanation. No backend observed it; it was derived from something else because a lesson needs the intermediate step visible — e.g. a `pwm.output` stage synthesised from a servo angle. | only when labelled |

Rules:

- A backend MUST NOT upgrade its own provenance. A simulator emits `simulated` even when it is
  confident.
- A receiver's *default* provenance is a deployment decision, and getting it wrong is the easiest
  way to lie to a learner. Renode/real-firmware bridge → `observed`. Replay harness or behaviour
  model → `simulated`. The reference parser makes this an explicit option
  (`defaultProvenance`) with `observed` as the default.
- An explicit `p=` tag always wins over the receiver's default.
- **`observed` does not mean "on hardware".** The row above lists an emulated UART and a physical robot under the same tag, which is ambiguous in the one direction that matters most. v2 adds an orthogonal `origin` field to the decoded event, and `isPhysicallyObserved()` — not `provenance === 'observed'` — is what a UI must branch on before presenting a value as a measurement. See `sesame-telemetry-v2.md` §6.

### 7.2 `traceId`

Every event may carry `x=<id>`. One user action produces one id, threaded through every layer:

```text
traceId=wave-0042
  ui.command        wave
  http.request      POST /api/command
  firmware.command  wave
  movement.enter    runWavePose
  servo.target      L3=180          <- @SESAME servo x=wave-0042 L3 180
  pwm.output        channel=6 …
  joint.target      L3=180
  visual.joint      L3=…
```

Only `servo.target` / `face.expression` / `oled.frame` / `log` are wire-expressible in v1; the
other stages are produced host-side with the same `traceId` and `provenance: "inferred"`. Trace
ids are opaque tokens: any non-whitespace characters, no length limit imposed by the protocol.

---

## 8. Decoded event union

```ts
type Provenance = 'observed' | 'simulated' | 'inferred';

interface Base {
  seq: number;              // required, monotonic per receiver
  provenance: Provenance;   // required
  simTimeUs?: number;
  traceId?: string;
  warnings?: { code: string; message: string }[];
}

type SesameTelemetry =
  | (Base & { type: 'servo.target';    joint: JointName; angleDeg: number })
  | (Base & { type: 'face.expression'; name: string; frame?: number })
  | (Base & { type: 'oled.frame';      width: 128; height: 64; pixels: string })
  | (Base & { type: 'log';             channel: 'uart' | 'firmware' | 'emulator'; text: string })
  // extensions beyond the research report's four:
  | (Base & { type: 'protocol.hello';   protocolVersion: number; emitter: string })
  | (Base & { type: 'protocol.unknown'; verb: string; args: string[]; reason: string; raw: string });
```

`JointName` is `'R1' | 'R2' | 'L1' | 'L2' | 'R4' | 'R3' | 'L3' | 'L4'`, imported from
`@sesame-lab/sesame-model`. It is not redefined here, in this document, or anywhere else.

---

## 9. Receiver requirements

A conforming receiver:

1. **Frames on bytes, before decoding.** A multi-byte UTF-8 sequence or an IAC escape split across
   two reads must not change the result. The emitted event sequence MUST depend only on the
   concatenated byte stream, never on chunk boundaries.
2. **Holds a trailing lone `CR`** until the next byte arrives, because the next byte may be `LF`
   and `CRLF` is one terminator. At end of stream, a held `CR` is a terminator.
3. **Caps the buffer.** A line with no terminator that exceeds the cap is discarded and reported
   as a `log` event on channel `emulator` stating the total byte count. A runaway emitter must not
   be able to exhaust memory. The count must be the same regardless of how the stream was chunked.
4. **Strips telnet IAC sequences** (`0xFF` + command, 3 bytes for `WILL`/`WONT`/`DO`/`DONT`) and
   drops undecodable bytes and C0 control characters, rather than letting them reach the grammar.
5. **Never throws on wire input** and **never silently drops a `@SESAME` line**. Everything is
   either a typed event, a warned typed event, or a `protocol.unknown`.
6. **Emits non-protocol text as `log` events** on channel `uart`, preserving order relative to the
   telemetry events around it.
7. **Ignores unknown verbs, unknown tags and extra trailing positional arguments** with a warning.
   See §10.

### Validation summary

| Condition | Result |
|---|---|
| unknown verb | `protocol.unknown` / `unknown-verb` |
| `@SESAME` with no verb | `protocol.unknown` / `missing-verb` |
| too few positional args | `protocol.unknown` / `bad-arity` |
| `servo` joint not in `JOINT_ORDER` | `protocol.unknown` / `unknown-joint` |
| `servo` angle not numeric | `protocol.unknown` / `bad-angle` |
| `servo` angle outside 0–180 | `servo.target` + `angle-out-of-range` warning (configurable to reject) |
| `servo` angle fractional | `servo.target` + `angle-not-integer` warning |
| `face` name unknown | `face.expression` + `unknown-face` warning (**passthrough**) |
| `face` name case-mismatched | `face.expression` + `face-name-case-mismatch` warning |
| `face` frame not a non-negative integer | `protocol.unknown` / `bad-frame` |
| `face` frame ≥ 6 or ≥ the face's frame count | `face.expression` + `frame-out-of-range` warning |
| `oled` encoding not `b64` | `protocol.unknown` / `bad-encoding` |
| `oled` payload not exactly 1024 decoded bytes | `protocol.unknown` / `bad-payload` |
| `log` channel unknown | `protocol.unknown` / `bad-channel` |
| `hello` version not an unsigned integer | `protocol.unknown` / `bad-version` |
| `hello` version newer than implemented | `protocol.hello` + `unsupported-version` warning |
| extra trailing positional args | event + `trailing-args` warning |
| unknown tag key | event + `unknown-tag` warning |
| recognised tag, unusable value | event + `bad-tag-value` warning |

---

## 10. Versioning and extension rules

The version is announced by `@SESAME hello <version>`, not embedded in every line.

**Backward-compatible changes** (no version bump required; receivers already tolerate them):

- a **new tag key** — receivers ignore unknown keys with a warning;
- **extra trailing positional arguments** on an existing verb — receivers ignore them with a
  warning, so a v1 receiver reads `@SESAME servo R4 72 1500` as `R4 → 72`;
- a **new verb** — receivers surface it as `protocol.unknown` with the raw line intact, so a bridge
  can still forward it.

**Breaking changes** (require `hello 2`):

- changing the meaning or position of an existing positional argument;
- changing the semantics of an existing tag key;
- changing the OLED pixel layout (add a new `encoding` token instead);
- changing the sentinel or the framing rules.

Reserved for future use, so do not squat on them: single-lowercase-letter tag keys other than
`s`/`t`/`p`/`x`, and the verbs `pwm`, `i2c`, `state`, `cmd`.

---

## 11. Emitting from C++ on an ESP32

Two hook sites, not one per movement function. Both are single `printf`s with no allocation.

```cpp
// firmware/sesame-firmware-main.ino, at the end of setServoAngle(),
// AFTER  angle = constrain(angle + servoSubtrim[channel], 0, 180);
Serial.printf("@SESAME servo %s %d\n", ServoNames[channel], angle);

// at the face-render point
Serial.printf("@SESAME face %s %d\n", faceName, frameIndex);

// once, at the end of setup()
Serial.println("@SESAME hello 1 sesame-fw-s2mini/0.1.0");
```

With a trace id, still one call:

```cpp
Serial.printf("@SESAME servo x=%s %s %d\n", traceId, ServoNames[channel], angle);
```

The framebuffer hook is the only expensive one — 1368 characters per frame — and should be
rate-limited or feature-gated:

```cpp
// immediately before display.display()
base64_encode(b64, (const char *)display.getBuffer(), 1024);   // 1368 chars + NUL
Serial.printf("@SESAME oled b64 %s\n", b64);
```

**Do not** emit `t=` from `micros()`. That is wall-clock time on real silicon, not emulator virtual
time, and labelling it as the latter would make replays look deterministic when they are not.

---

## 12. A minimal Python replay harness

```python
import re, socket

SENTINEL = "@SESAME"

def replay(lines, host="127.0.0.1", port=3456):
    with socket.create_connection((host, port)) as s:
        for line in lines:
            s.sendall((line + "\n").encode("utf-8"))
```

Remember to set the consumer's default provenance to `simulated` when replaying synthesised
lines. A replay stream that arrives labelled `observed` is the exact failure mode the provenance
tag exists to prevent.

---

## 13. Known limitations of v1

| # | Limitation | Mitigation |
|---|---|---|
| 1 | A `log` message body containing `@SESAME ` is re-split into a bogus segment. | Emitters must not embed the sentinel in message bodies. A v2 could add an escaped text field. |
| 2 | A telnet IAC option byte that happens to be `0x0A` will split a line early, because framing happens before IAC stripping. | Use `telnetMode: false`, as R1 established. Framing-before-stripping is deliberate: it is what makes the output chunk-independent. |
| 3 | `seq` is assigned by the receiver unless the emitter sends `s=`, so loss between emitter and receiver is invisible. | Emitters that care can send `s=`; the cost is a counter and ~5 bytes per line. |
| 4 | An `oled` line is 1385 bytes at ~115200 baud ≈ 120 ms of wire time. Streaming frames at animation rate is not possible on UART0. | Frames are for stepping and inspection, not for live animation; use `face.expression` for motion. |
| 5 | No host → device direction. | **Fixed in v2** (`sesame-telemetry-v2.md`): commands go over this same UART as serial-CLI lines. Under QEMU the HTTP option does not exist at all — Wi-Fi is precisely what the emulator cannot model. |

---

## 14. Conformance corpus

`packages/sesame-protocol/src/__tests__/` is the executable form of this document: 255 tests
covering round-trip identity for every event kind, chunk-boundary fuzzing at every offset, noisy
and telnet-contaminated streams, and every row of the validation table in §9. An implementation in
another language should reproduce `fixtures.ts`'s `nastyStream()` and match its event sequence.
