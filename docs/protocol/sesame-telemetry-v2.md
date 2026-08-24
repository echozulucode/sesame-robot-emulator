# Sesame Telemetry Protocol — v2: the host → device direction

**Status:** implemented · **Task:** Q2 (Phase 1) · **Date:** 2026-08-23
**Reference implementation:** `packages/sesame-protocol` (`commands.ts`, `origin.ts`)
**Supersedes nothing.** v1 (`sesame-telemetry-v1.md`) is still the device → host specification and
is unchanged on the wire. Read it first; this document is a delta.

---

## 0. What v2 adds, in one paragraph

v1 §2 said *"Direction: device → host only. v1 defines no host → device messages"*, and §13
limitation 5 said commands go over HTTP or the Renode monitor. Under QEMU neither exists — HTTP
needs a radio QEMU does not model. v2 defines the missing direction **over the same UART0**, and
defines it by *adopting a wire format that already exists*: the stock firmware's serial console at
`sesame-firmware-main.ino:785`–`:875`. It also adds `origin`, a decoded-event field that says what
kind of thing observed an event, because `provenance: "observed"` cannot tell an emulator from
silicon and v1's own definition of the tag lists both.

| | v1 | v2 |
|---|---|---|
| device → host wire | `@SESAME` lines | **byte-identical** |
| `@SESAME hello <n>` | `1` | **still `1`** — see §1 |
| host → device wire | none | the firmware's serial CLI, unchanged |
| decoded event fields | `seq` `provenance` `simTimeUs` `traceId` `warnings` | **+ `origin`** |
| typed command union | none | `SesameCommand` + `encodeCommand()` |

---

## 1. Versioning, honestly

**`@SESAME hello` still announces `1`, and that is not an oversight.**

`hello` announces the *telemetry wire version* — the grammar, the verbs, the tag set, the framing
rules. v2 changes none of them. Bumping it would have meant either patching
`firmware/patches/telemetry-instrumentation.patch` to announce a version whose only difference is a
direction the firmware does not implement, or leaving every conforming v1 emitter announcing a
version this document says is stale. Both are worse than a number that stayed still because nothing
under it moved.

So the package exports two constants and they are different on purpose:

```ts
PROTOCOL_VERSION = 1   // the @SESAME telemetry wire. Announced by hello.
SPEC_VERSION     = 2   // this document.
COMMAND_CHANNEL  = 'serial-cli/upstream-1.0'
```

`COMMAND_CHANNEL` names the host → device grammar. `upstream-1.0` because the grammar belongs to
upstream Sesame firmware, not to this project.

A v2 receiver talking to a v1 emitter is the normal case and needs no negotiation: the emitter is
unchanged, and whether the *device* can accept commands is a property of the backend, reported in
`SesameCapabilities.serialConsole`, not something to infer from a version number.

---

## 2. Host → device transport

| Property | Value |
|---|---|
| Medium | **the same UART0** the telemetry leaves by, written to |
| Encoding | ASCII, `0x20`–`0x7E` only |
| Framing | one command per line, terminated by `LF` |
| Max line | **31 bytes**, excluding the terminator |
| Flow control | none; see §5 |

### 2.1 Why the terminator is `LF` and not `CRLF`

`if (c == '\n' || c == '\r')` (`:789`) accepts either. `CRLF` would submit the buffer on the `CR`
and then submit an *empty* buffer on the `LF`. The empty one is harmless — `if (buffer_pos > 0)`
guards it at `:790` — but `LF` alone is one byte and no ambiguity.

### 2.2 Why 31 bytes is a hard limit and not a guideline

```c
static char command_buffer[32];
...
} else if (buffer_pos < sizeof(command_buffer) - 1) { command_buffer[buffer_pos++] = c; }
```

`:787`, `:874`. The 32nd byte is the NUL written at `:790`. **Every byte past the 31st is dropped
silently** — no error, no truncation marker, nothing on the wire. An over-long line therefore does
not fail; it arrives as a *different, shorter line* and may dispatch to a different branch. That is
why `encodeCommand()` refuses rather than truncating.

---

## 3. The dispatcher is order-sensitive, and encoding must survive it

The console is one `if / else if` chain of `strcmp` and `strncmp`. `hardware/hardware-map.json →
commands.serialCliDispatchNote` records the consequence:

> Serial CLI matching is prefix-order-sensitive: `strcmp("subtrim save")` is tested at line 833
> AFTER the exact `strcmp("subtrim")` at 825 but BEFORE the `strncmp("subtrim ", 8)` at 846, and the
> `st ` abbreviation is disambiguated by inspecting `command_buffer[1]`. `strncmp(command_buffer,
> "st ", 3)` at line 846 also matches `"st save"`/`"st reset"` prefixes, which are caught earlier.

So "encode a command" is not "write the obvious string"; it is "write a string that lands on the
branch you meant". v2 makes that checkable rather than assumed:

```ts
classifyCliLine(line: string): CliBranch
```

is a transcription of `:791`–`:872` **in source order**, including both places the firmware
disambiguates an abbreviation by peeking at `command_buffer[1]` (`:819`, `:847`). Every one of the
26 forms in `hardware-map.json` is run through it in `commands.test.ts`, and `encodeCommand()`
verifies its own output against it before returning.

### 3.1 The branches, in order

| # | Test | Branch id |
|---|---|---|
| 1–19 | `strcmp` against `run walk`/`rn wf`, `rn wb`, … `rn cb` | `run-walk` … `rn-cb` |
| 20 | `strncmp("face ", 5)` \|\| `strncmp("fc ", 3)` | `face` |
| 21 | `strcmp("subtrim")` \|\| `strcmp("st")` | `subtrim-show` |
| 22 | `strcmp("subtrim save")` \|\| `strcmp("st save")` | `subtrim-save` |
| 23 | `strncmp("subtrim reset", 13)` \|\| `strncmp("st reset", 8)` | `subtrim-reset` |
| 24 | `strncmp("subtrim ", 8)` \|\| `strncmp("st ", 3)` | `subtrim-set` |
| 25 | `strncmp("all ", 4)` | `all` |
| 26 | `sscanf("%d %d") == 2` | `motor` |
| — | fell off the end | `none` — the firmware prints nothing and does nothing |

### 3.2 The traps, and how v2 avoids them

| Input | Reaches | Why it is a trap |
|---|---|---|
| `st` | `subtrim-show` | One character from `rn st`, which stands the robot up. **v2 encodes `stand` as `run stand`** — three bytes more, no ambiguity. |
| `st save`, `st reset` | `subtrim-save`, `subtrim-reset` | Both are `st `-prefixed and would hit branch 24 if branches 22/23 were reordered. v2 encodes the subtrim family with the **long** spellings, so it does not depend on that ordering. |
| `fc save`, `face subtrim` | `face` | Branch 20 is tested before every subtrim branch, so these are faces called `save` and `subtrim`. Correct, and worth a test. |
| `st x` | `subtrim-set` | Does **not** fall through to `motor`. The branch is taken, the inner `sscanf` fails, nothing happens. |
| `all` (no space) | `none` | Branch 25 requires the trailing space. |
| a 40-byte `fc …` | `face`, truncated | Only the first 31 bytes ever existed as far as the firmware is concerned. |

---

## 4. The command union

```ts
type SesameCommand =
  | { type: 'movement.run';  command: string }                       // 19 words
  | { type: 'face.set';      name: string }
  | { type: 'servo.set';     joint: JointName; angleDeg: number }
  | { type: 'servo.setAll';  angleDeg: number }
  | { type: 'subtrim.set';   channel: number; valueDeg: number }
  | { type: 'subtrim.reset' }
  | { type: 'subtrim.show' }
  | { type: 'subtrim.save' }
  | { type: 'command.stop';  currentFace: string };                   // derived — see 4.2
```

`encodeCommand(cmd)` returns `{ line, bytes, branch, derived, note? }` or throws
`CommandEncodeError`. It never returns something it has not checked against §3.

### 4.1 Names are sanitised before transmission, not after

A face name reaches the console straight from user input. Unsanitised, a space would end the name
early, a newline would submit the buffer and turn the remainder into a second command, and `@SESAME `
would forge a telemetry segment on the way back out (v1 §3.2). `safeCliToken()` is the firmware's own
`sesameSafeToken()` (`telemetry-instrumentation.patch:105`–`:116`) run host-side: reduce to
`[A-Za-z0-9_.-]`, substitute `_`, cap at 23, never empty. `fc ` + 23 = 26 bytes, comfortably inside
the 31-byte budget.

### 4.2 `stop` is derived, and the derivation is stated

**The serial console has no `stop`.** That is a gap in upstream, not an omission here. The only CLI
branch that writes `currentCommand = ""` is the face branch (`:821`), so `command.stop` encodes as
`fc <currentFace>` — and asking for the face already showing makes it a no-op on the panel too,
because `setFace()` opens with

```c
if (faceName == currentFaceName && currentFaceFrames != nullptr) return;   // :904
```

The current face must be supplied by the caller rather than guessed, because supplying the wrong one
changes the face — the exact side effect the encoding exists to avoid. `EncodedCommand.derived` is
`true` and `note` explains it, so a UI showing a learner "what was sent" can say *"there is no stop
command; this is what the firmware gives you instead"* rather than implying one exists.

### 4.3 Two behavioural differences from the HTTP path

Both are properties of the console being a different entry point, not of any emulator:

- **`forward` / `backward` / `left` / `right` run once.** `:795`–`:798` set `currentCommand`, call
  the gait, and clear it. Over HTTP the variable stays set and `loop()` repeats forever. One
  iteration is also `SimulatedSesameRobot`'s default (`continuousIterations: 1`), so the two
  backends agree by construction.
- **`run rest` / `run stand` never set `currentCommand` at all** (`:799`–`:800`), where the HTTP path
  sets it and lets `loop()` dispatch. The servo and face output is identical.

A useful corollary: **after any completed console command, `currentCommand` is `""`.** Every
movement branch either never sets it, clears it immediately, or is a pose function that clears
itself on the way out (`movement-sequences.h:106` and its fourteen siblings). A backend can report
`motion.command` from that fact rather than from a host-side guess.

---

## 5. Completion: the barrier

There is no ack framing, no sequence number and no flow control on the console. What there *is* is a
strict ordering guarantee, and it is enough.

The console reads **one character per `loop()` iteration** — a single `Serial.read()` at `:788`, not
a drain loop — and executes a completed line synchronously inside that iteration. So two lines
written back to back cannot interleave: the second is not even *read* until the first has returned,
however long its choreography took.

That turns any command with distinctive output into a fence. v2 names one:

```ts
BARRIER_COMMAND = 'subtrim'
BARRIER_MARKER  = 'Subtrim values:'      // :826
```

`subtrim` is the only console verb that is purely read-only *and* prints an unmistakable first line.
Write `<command>\nsubtrim\n` in a single write and wait for the *n*-th `Subtrim values:`; when it
arrives, command *n* has finished. No polling, no fixed sleep, no assumption about how fast the
emulator is running today.

**The cost, stated:** `recordInput()` runs at `:792` for every console line including this one, so
the barrier refreshes `lastInputTime` and suppresses the 30-second Wi-Fi info scroll. There is no
read-only branch that avoids it — `recordInput()` runs before the chain.

### 5.1 Batching

Several lines may share one barrier; the ordering guarantee covers all of them. The limit is UART0's
receive ring buffer (256 bytes by default in arduino-esp32), which the console drains one character
per `loop()` while stalling for the whole of every `setServoAngle()`. The reference implementation
caps a batch at **192 bytes** and refuses beyond it, because an overflow there is silent.

### 5.2 Other acknowledgements

Non-normative, for logging: `Face set to ` (`:822`), `Servo <n> set to <a>` (`:872`),
`All servos set to <a>` (`:867`), `Motor <n> subtrim set to <v>` (`:853`),
`All subtrim values reset to 0` (`:844`).

---

## 6. `origin` — what observed this

### 6.1 The problem

v1 §7.1 defines `observed` as *"bytes crossed the emulated UART, the firmware hook really ran, **or**
the physical robot really moved"*. Those are three very different claims under one tag. A QEMU run is
`observed` and is:

- an **emulator**, not silicon;
- the **legacy Distro V1 ESP32**, not the current S3 and not the S2 Mini the report recommends for
  DIY builds (QEMU has no `esp32s2` machine at all);
- firmware with **Wi-Fi elided** and a **DIO bootloader** substituted — whole subsystems absent
  rather than merely quiet.

A learner shown "observed" beside a servo angle, and left to conclude a robot moved, has been misled.
Prose in a README does not fix it, because the prose is not attached to the event.

### 6.2 Why not a fourth provenance

Adding `'emulated'` to `Provenance` is the obvious move and it is wrong. `Provenance` answers *how
much epistemic weight does this carry*; origin answers *which boundary was crossed*. Merging them
forces a choice for every future backend — is a hardware-in-the-loop rig `observed` or `emulated`? —
and silently reclassifies every existing event. They are orthogonal, so they are two fields.

### 6.3 The field

```ts
interface TelemetryOrigin {
  kind: 'physical-robot' | 'emulator' | 'host-model' | 'replay' | 'unknown';
  engine?: string;                    // 'qemu-system-xtensa/9.2.2-esp_develop_9.2.2_20260417'
  board?: string;                     // 'distro-v1-esp32' — as hardware-map.json spells it
  elided?: readonly string[];         // subsystems NOT modelled: their silence is not evidence
  firmwareDeviations?: readonly string[];
}
```

Added to `TelemetryEventBase` as `origin?: TelemetryOrigin`.

**It is not a wire field.** There is no tag for it and no way for an emitter to set it. Like
`defaultProvenance`, it is stamped by whoever owns the transport (`defaultOrigin` on the parser),
because the firmware has no way to know it is running under an emulator and must not be asked to
assert that it is not.

`elided` is the field that carries *negative* evidence. Without it, "no Wi-Fi events" reads as "the
radio was idle" instead of "there is no radio".

### 6.4 The predicate

```ts
isPhysicallyObserved(event)   // provenance === 'observed' && origin?.kind === 'physical-robot'
```

**This, not `provenance === 'observed'`, is what a UI branches on before saying "the robot did
this".** Absent origin returns `false`: unknown is *not known to be physical*, never physical by
default. `describeOrigin()` renders a short label and never returns the empty string, so a UI that
interpolates it cannot end up displaying an unqualified "observed".

### 6.5 Compatibility

`origin` is optional and absent by default, so every v1 event, fixture and test is unchanged. A v1
consumer ignores it. The only v2 requirement on a *producer* is the one in §6.3: if you know, say.

---

## 7. Exposing the direction over the bridge

`emulator/bridge` gained an **opt-in, loopback-only** control path (`--allow-control`). The default —
discard every client message — is unchanged, and the reasoning for keeping it is in
`emulator/bridge/src/control.ts`: the telemetry port has no authentication, it is a fan-out port, and
`--allow-remote` exists. `--allow-control` and `--allow-remote` together are **refused at startup**,
and every message is re-checked against its peer address regardless, because a bind address is not a
statement about who connected.

Message shape:

```json
{ "v": 2, "type": "command", "command": { "type": "movement.run", "command": "wave" } }
```

There is no raw-text escape hatch: the only thing that reaches the UART is `encodeCommand()`'s
output. Every accepted and every refused command is announced on the telemetry stream as an
`emulator`-channel `log`, so the reason a robot moved is in the same ordered stream as the movement.

---

## 8. Limitations of v2

| # | Limitation | Notes |
|---|---|---|
| 1 | **No `stop` verb on the device.** | §4.2 derives one. A firmware patch adding `stop` would be a real improvement and is not in scope. |
| 2 | **31 bytes per line.** | Enough for every command in §4, with 5 bytes to spare on the longest. A future verb with a long argument would not fit. |
| 3 | **No ack correlation.** | The barrier gives ordering, not identity. Two commands in flight from two callers cannot be told apart; the reference backend serialises instead. |
| 4 | **Barrier disturbs `lastInputTime`.** | §5. Unavoidable: `recordInput()` runs before the dispatch chain. |
| 5 | **`origin` is not on the wire.** | Deliberate (§6.3), but it means a raw UART capture replayed later has lost it unless the replayer re-stamps. |
| 6 | **`subtrim` values are not readable as data.** | The console prints them; nothing parses them back yet, so `JointState.subtrimDeg` is left absent rather than guessed. |
| 7 | All of v1 §13 still applies. | Nothing there was fixed. |

---

## 9. Conformance

`packages/sesame-protocol/src/__tests__/commands.test.ts` — 25 cases: every one of the 26 extracted
forms through the dispatch model, each trap in §3.2 by name, and every member of the union encoded
and re-classified. `emulator/bridge/src/__tests__/control.test.ts` — 11 cases, starting with the one
that asserts the v1 discard is still the default.
