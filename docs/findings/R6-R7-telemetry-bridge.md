# R6 + R7 — Instrumented-firmware telemetry hook, and the bridge

**Tasks:** R6 (Experiment 7 / Gate B) and R7 (Experiment 8) · **Date:** 2026-08-23
**Agent:** `telemetry-bridge` · **Depends on:** F3, F4, F6, R5
**Protocol:** `docs/protocol/sesame-telemetry-v1.md`

**Result: both PASS. Path A and Path B are both proven.** The instrumented
profile builds clean and bit-for-bit reproducibly; its emitted format is verified
against the R5 parser using literals extracted from the firmware rather than
retyped; telemetry flows end-to-end from a socket to a browser canvas with an
automated test that proves it with nobody watching; and the Path A / Path B
contract test passes against **real Renode** — the same telemetry, produced once
by an emulated Xtensa core writing UART MMIO and once by a plain socket, yields
byte-identical WebSocket output.

**Gate B is answered YES via instrumented firmware.** The one thing still missing
is silicon: no ESP32-S2 has executed these hooks (§10).

---

## 1. Gate B answer

> *Can a servo target be captured deterministically?*

**Yes — by instrumented firmware, at build level, pending silicon.**

| Property | Evidence |
|---|---|
| Captured at all | `@SESAME servo <joint> <deg>` is emitted from the single convergence point in `setServoAngle()`. All 21 movement functions and all 223 servo steps in `hardware-map.json` route through it. |
| Deterministic | The instrumented ELF is byte-identical across a full clean rebuild (§3.3). The value emitted is the post-subtrim, post-clamp integer that reached `Servo::write()`, not the requested angle. |
| Correct on the wire | The three shipped format literals are present verbatim in the built `.elf` and `.bin`, and decode through the R5 parser to the intended events with zero warnings (§4). |
| Observed across a real boundary | Partly. R3's probe emits `@SESAME servo R4 72` from an **emulated ESP32-S2 writing UART0 MMIO**, and the bridge decodes it correctly (§7) — so the transport half is observed. The hooks themselves have not executed: the full instrumented image still needs R4's boot ladder, or a board. See §10. |

The **emulated-peripheral** route to Gate B (a real LEDC/PWM model in Renode)
remains unproven and is not this task's to answer; R4 and the Gate-B report own
that half.

---

## 2. The two hook sites

Exactly two, plus a one-shot boot banner. Instrumenting the 21 movement functions
individually would have been 223 hook sites, each free to disagree with what
actually reached the servo.

`firmware/patches/telemetry-instrumentation.patch`
· sha256 `c3b43c05ae69b17859f9e6c2c86c2833e53a266f5966b7897b5547f60e3ad3d2`
· 4 hunks, 126 lines added, **0 removed**. `firmware/upstream/` is untouched.

### Hook 1 — `setServoAngle()`

`firmware/sesame-firmware-main.ino:1051`–`:1057` (F4 provenance:
`hardware-map.json` → `servos.servoConfig.angleClamp.source` = `:1053`,
`motorCurrentDelay.appliedSource` = `:1055`).

```c
int adjustedAngle = constrain(angle + servoSubtrim[channel], 0, 180);   // :1053
servos[channel].write(adjustedAngle);                                   // :1054
sesameEmitServo(channel, adjustedAngle);                                // <-- hook
delayWithFace(motorCurrentDelay);                                       // :1055
```

Placed **after the clamp** so the reported number is the one the servo library
got, and **before `delayWithFace()`** because that call is not dead time. F4
established that `delayWithFace()` spins for the duration while pumping
`updateAnimatedFace()`, `server.handleClient()` and
`dnsServer.processNextRequest()` — it is a re-entrancy point that can itself
produce further telemetry through hook 2. Emitting after it would report the
servo change *later* than face changes it actually preceded.

The joint name comes from `ServoNames[]` (`firmware/movement-sequences.h:16`), so
the wire name is the firmware's own spelling and the non-geometric
`R1,R2,L1,L2,R4,R3,L3,L4` order cannot drift.

### Hook 2 — `updateFaceBitmap()`

`firmware/sesame-firmware-main.ino:887`–`:891`.

```c
display.drawBitmap(0, 0, bitmap, 128, 64, SSD1306_WHITE);   // :889
sesameEmitFace(currentFaceName, currentFaceFrameIndex);     // <-- hook
#if SESAME_TELEMETRY_OLED
sesameEmitOled(display.getBuffer());                        // off by default
#endif
display.display();                                          // :890
```

`updateFaceBitmap()` is the face equivalent of `setServoAngle()`: every rendered
frame passes through it, from four call sites — `setFace()` frame 0 (`:932`),
every `updateAnimatedFace()` step (`:991`), and both `updateWifiInfoScroll()`
restores (`:1089`, `:1114`). `currentFaceName` and `currentFaceFrameIndex` are
already correct at all four, so the hook reports the frame that is about to reach
the glass rather than the one that was requested.

### Boot banner — end of `setup()`

`@SESAME hello 1 sesame-fw-s2mini/0.1.0`, after
`sesame-firmware-main.ino:749`. The protocol (§5.5) says emitters SHOULD send it;
the plan said "two hook sites", meaning two *event-emitting* instrumentation
points in the runtime paths, and this is counted separately as what it is — a
one-shot banner, trivially deletable.

### A hardening decision that was not optional

Face names reach hook 2 **straight from user input**. `POST /api/command` carries
a `face` field (`:366`) and the serial console accepts `face <name>` (`:818`), and
`setFace()` stores whatever it was handed in `currentFaceName` even when the table
lookup misses (`:906`). An unfiltered name containing a space would break the
token split, and one containing `@SESAME ` would forge a second segment — the
protocol scans for the sentinel at *any* offset (spec §3.2).

So `sesameSafeToken()` reduces the name to `[A-Za-z0-9_.-]`, never empty, always
terminated, no allocation. The test asserts the character class in the patch
itself excludes space and `@`, rather than re-implementing the sanitiser and
testing the re-implementation.

### The six R5 warnings, and what was done about each

| Warning (raised in R5) | Disposition |
|---|---|
| Tags must sit between verb and args; `@SESAME servo R2 t=1234 45` parses as `bad-angle` | No literal emits any tag. Asserted by regex over every extracted literal, and by the build driver. |
| Do not emit `t=` from `micros()` on real silicon | No `t=` anywhere; the patch contains no `micros()` call. Asserted. |
| `log` bodies must never contain `@SESAME ` | Firmware emits **no `log` verb at all** — plain `Serial.println` text arrives as a `log`/`uart` event via the parser, which is safe by construction. Asserted. |
| The 1385-byte `oled` line is ~120 ms at 115200 baud | The framebuffer hook ships **disabled**: `#define SESAME_TELEMETRY_OLED 0`, with a 500 ms rate limit if enabled. Its literal is verifiably **absent** from the built binary, which is the proof the gate works. |
| Verify byte-for-byte against the real literal | §4. |
| No board available → mark hardware verification pending | §10. |

---

## 3. Build: the `s2mini-instrumented` profile

Added to F3's system in three places — `firmware/build/sketch.yaml` (declarative
pinning, FQBN/core/libraries identical to `s2mini` so the delta is attributable),
`scripts/build-firmware.mjs` (`PROFILES` entry), and both wrappers' profile
allowlists.

```
node scripts/build-firmware.mjs s2mini-instrumented [--clean]
```

### 3.1 Not trusting `git apply`'s exit code

F3's trap — the scratch sketch lives inside the repo work tree, so `git apply`
resolved paths against the repo root, printed `Skipped patch` and **exited 0** —
applies identically here. F3's `git init` fix and its `Skipped patch` string check
are inherited, but the real defence is the same one F3 used for pins: **assert on
the generated source.** The driver now checks, for this profile:

- `sesameEmitServo(...)` appears strictly between the clamp/`write()` and
  `delayWithFace(motorCurrentDelay)`;
- `sesameEmitFace(...)` appears strictly between `drawBitmap()` and
  `display.display()`;
- each anchor is present *exactly once*;
- `#define SESAME_TELEMETRY_OLED 0` is present;
- `servo`, `face` and `hello` literals exist, none carries a tag in an argument
  slot, none uses the `log` verb, all are newline-terminated.

A patch that applies but lands in the wrong place now fails the build:

```
[patch] applied telemetry-instrumentation.patch (sha256 c3b43c05ae69b178...)
[verify] OK  board=s2-mini servoPins=[1,2,4,6,8,10,13,14] SDA=33 SCL=35
[telemetry] OK  4 @SESAME literals, hooks in place, OLED hook disabled
[build] OK in 113.8s
```

### 3.2 Flash / RAM delta versus stock `s2mini`

Both builds: same FQBN, same core 3.3.11, same pinned libraries, same board
options. The only difference is the patch.

| | `s2mini` | `s2mini-instrumented` | Δ |
|---|---:|---:|---:|
| Flash (arduino-cli "program") | 1 120 590 | 1 120 946 | **+356 B** (+0.03 %) |
| ...of 1 310 720 (1.2 MB app slot) | 85.49 % | **85.52 %** | +0.03 pt |
| RAM (`.dram0.data` + `.dram0.bss`) | 79 632 | 79 632 | **+0 B** |

Per-section, from `xtensa-esp32s2-elf-size -A`:

| Section | `s2mini` | instrumented | Δ |
|---|---:|---:|---:|
| `.flash.text` | 803 934 | 804 198 | +264 |
| `.flash.rodata` | 212 012 | 212 104 | +92 |
| `.dram0.data` | 17 928 | 17 928 | 0 |
| `.dram0.bss` | 61 704 | 61 704 | 0 |

**+356 bytes of flash and zero bytes of RAM.** F3 flagged the 1.2 MB app
partition as 85–87 % full with ~170–190 KB of headroom; the instrumentation
consumes 0.2 % of that headroom. The zero RAM cost is the payoff for the
`char safe[24]` living on the stack and the 1369-byte base64 buffer being inside
`#if SESAME_TELEMETRY_OLED`. Enabling the OLED hook would cost ~1.4 KB of `.bss`
and is the reason it is a compile flag rather than a runtime one.

### 3.3 Determinism — bit-for-bit, same as the other three

Build → `--clean` (wipes scratch sketch *and* the arduino-cli build directory) →
rebuild → compare.

| Artifact | SHA-256 | Reproduced |
|---|---|---|
| `.elf` (15 508 524 B) | `b14a916134ac4bf711ba80ca34932ed2b04ea5af95e2e575648c78de88f0005f` | identical, 2 runs |
| `.bin` (1 121 088 B) | `25b0290561485e6e81c1b4ec667e8f1073301d94ad8a9ed06ef7b65c26860073` | identical, 2 runs |

Recorded in `reproducibility.json` → `builds[]` alongside the other three
profiles. Same caveat as F3: this is same-machine reproducibility; the absolute
build path is embedded.

---

## 4. Byte-for-byte format verification, and why the obvious test is worthless

The obvious test writes `expect(parse('@SESAME servo R4 72')).toMatchObject(...)`
and calls it verification. It verifies nothing about the firmware. If the C
literal said `@SESAME srvo`, or put a tag after the joint, or dropped the
newline, that test still passes: **two copies of the same typo agree with each
other perfectly.**

So no `@SESAME` string is typed anywhere in the verification. There is one
authoritative source — the patched firmware — read three independent ways.

**Level 1 · patch → parser.** `firmware-format.test.ts` reads
`firmware/patches/telemetry-instrumentation.patch`, keeps only lines the patch
*adds* (a literal in a context line would be upstream's, and upstream has no
telemetry), strips comments, and extracts every `@SESAME…` C string literal by
regex. Each is unescaped, rendered through a small `%s`/`%d`/`%u` printf, and fed
to `SesameTelemetryParser`. The test supplies only the arguments and the expected
decoded meaning. It also fuzzes the servo stream at **every single byte offset**
and asserts the event sequence is unchanged. Works on a clean clone with no
toolchain.

**Level 2 · patch → checked-in evidence.**
`scripts/extract-telemetry-literals.mjs` writes
`firmware/build/telemetry-literals.json`, which is committed. A test asserts the
evidence file's literal set still equals the patch's, so the evidence cannot rot
while looking authoritative.

**Level 3 · patch → built binary.** The strongest, and the only one that proves
the bytes survived the compiler. Artifacts are gitignored, so this level is
`skipIf`-skipped **with the reason and the command to fix it in the test name**,
never silently absent. On this machine it ran and passed:

| Literal | `.elf` | `.bin` | Expected |
|---|---|---|---|
| `@SESAME servo %s %d\n` | `0x181c` | `0x81c` | present |
| `@SESAME face %s %u\n` | `0x1532` | `0x532` | present |
| `@SESAME hello %d %s\n` | `0x1807` | `0x807` | present |
| `@SESAME oled b64 %s\n` | — | — | **absent** (compile-gated) |

Plus a control: the **stock** `s2mini` ELF contains no `@SESAME` bytes at all. If
it did, the +356 B delta would be measuring something else.

The OLED row is the interesting one. Its absence is not a missing feature; it is
the machine-checkable proof that `#if SESAME_TELEMETRY_OLED` really does keep the
120 ms line out of the binary.

---

## 5. The bridge

`emulator/bridge/` — `@sesame-lab/sesame-bridge`, ~930 lines of TypeScript,
one runtime dependency (`ws`).

```text
Renode socket terminal ─┐
                        ├─ TCP ─► UartClient ─► SesameTelemetryParser ─► WsHub ─► browser
replay harness ─────────┘         (reconnect)     (@SESAME framing)      (+ ring buffer)
```

### 5.1 The one design decision everything else follows from

**The replay harness is a TCP server, not a file reader wired into the parser.**

Renode exposes its UART as a TCP server
(`emulation CreateServerSocketTerminal <port> "term" false` — third argument is
`telnetMode` and R1 established it must be `false`). If Path B fed the parser
directly, it would prove the parser works and nothing else. By putting a socket
in exactly the same place, **Path B exercises byte-for-byte the same client code
as Path A**: the same connect, the same reconnect, the same chunk boundaries, the
same backpressure, the same fan-out. That is what makes a contract test between
the two mean something instead of comparing two different programs.

### 5.2 Components

| File | What, and the non-obvious part |
|---|---|
| `uart-client.ts` | Reconnecting TCP client. Backoff is armed **before** the down-callback fires, so a handler is allowed to decide there is nothing to reconnect to and call `stop()`. A clean disconnect after a good session resets the backoff rather than inheriting an old one. |
| `backoff.ts` | Exponential + jitter. The jitter is functional: Renode's socket terminal takes one client, and a deterministic delay makes every watcher collide again on every attempt. |
| `replay-server.ts` | TCP server playing a `.jsonl` fixture (`{tMs, line}`) or a plain captured log. Schedules against an **absolute** timeline, not per-step sleeps, so timer overshoot cannot accumulate over 400 steps. Same-timestamp lines are written in one segment, so real bursts happen. `speed: 0` removes waiting entirely for tests. |
| `ws-hub.ts` | `ws` server on an `http.Server` that also serves `debug-viewer/`. Ring buffer replayed to every joining client — necessary, because a robot that has finished moving produces no further events and a reloaded tab would otherwise stare at an empty canvas forever. Client→server messages are discarded, not interpreted: this port must not become an accidental control API. |
| `bridge.ts` | Wiring plus lifecycle. The parser instance **survives reconnects** (it holds a partial line and the sequence counter); on disconnect it is flushed, because bytes already delivered must not become dependent on connection lifetime. |
| `config.ts` / `cli.ts` | Flags, and the defaults below. |
| `envelope.ts` | The WebSocket frame. |

### 5.3 Two decisions worth arguing with

**Bind to localhost.** `wsHost` and `uartHost` default to `127.0.0.1`.
`--allow-remote` exists and prints a warning that this stream is the seam robot
control will later ride on and has no authentication. The research report is
explicit about not publishing a robot control API onto a wider network by
accident.

**Provenance defaults to `simulated` in replay mode.** A replayed stream is a
rendering, not an observation; labelling it `observed` is precisely the lie the
provenance tag exists to prevent. The honest label is the free one and the
dishonest one needs `--provenance observed`. A live socket defaults to
`observed`.

### 5.4 The envelope, and why it is not just the event

```json
{ "v": 1, "n": 42, "origin": "uart", "tHostMs": 1755950000000, "event": { … } }
```

The bridge has to be able to talk about *itself* — "uart disconnected; retry 1 in
210 ms", "replay pass 3 complete". Those are not observations of the robot. Mixed
into one undifferentiated stream, a client cannot tell a fact about the robot from
a fact about the plumbing, and the contract test cannot compare two runs whose
plumbing differs by construction.

So `origin` splits them, and each origin has its **own `seq` space**. Mixing them
would make the robot's sequence numbers depend on how many times a socket
happened to reconnect. `n` is the cross-origin envelope index, for gap detection.
Bridge lifecycle events are `log` on channel `emulator` with provenance
`observed` — the bridge genuinely did watch its own socket open; that is a fact
about the harness, and the robot-facing events it wraps carry the stream's own
provenance, which in replay mode is `simulated`.

One small ordering bug found and fixed by the tests: the hub notified
`onClientCount` *before* sending the backlog, so the resulting lifecycle event
reached the new client as envelope `n+1` ahead of `1..n`, and then again inside
the backlog — a gap and a duplicate in the same connect.

### 5.5 `debug-viewer/`

One file, 308 lines, raw canvas, no React, no build step, no dependencies. Eight
labelled joint bars in `JOINT_ORDER` (`R1,R2,L1,L2,R4,R3,L3,L4` — the firmware
enum order, with a comment saying not to "fix" it to alphabetical), a 128×64
pixel grid decoding the SSD1306 page layout, a stream log, and a provenance badge
so a `simulated` stream cannot be mistaken for an `observed` one. Its header
comment says, in capitals, that it is a throwaway.

Served by the bridge itself under `--serve-viewer`, so the demo is one process
and one URL.

---

## 6. Path B — proven

`scripts/build-replay-fixture.mjs` renders a real choreography from
`hardware/hardware-map.json` (F4's 21 movement functions / 395 steps) into a
timed `@SESAME` stream. The shipped fixture is **`runWavePose`** —
`firmware/movement-sequences.h:91-107` — as
`emulator/bridge/fixtures/wave-pose.replay.jsonl`: **35 lines, 3 680 ms**, being
1 `hello`, 29 `servo`, 2 `face` and 3 plain `Serial.println` lines.

It is a *rendering*, and the header says so. What is modelled, from source:

- `servo` steps → `@SESAME servo <joint> <deg>` followed by `motorCurrentDelay`
  (20 ms), because `setServoAngle()` always ends in `delayWithFace()`. Subtrim is
  0 for all 8 channels and every mapped angle is inside 0–180, so the post-clamp
  value equals the requested one.
- `face` steps → `@SESAME face <name> 0`, but only when the name changes
  (`setFace()` early-returns at `:904`) **and only when the face has frames**.
- `call` recurses (`runStandPose`, `enterIdle`), `repeat` repeats,
  `conditional` is evaluated against the call's arguments, `delay` and
  `interruptCheck` advance the clock.

What is deliberately **not** modelled, so nobody mistakes the fixture for a
recording: inter-frame face animation (`updateAnimatedFace()` fires from inside
`delayWithFace()` at the face's fps — reproducing it needs wall-clock timing we do
not have), the OLED framebuffer, and timing jitter.

### 6.1 A firmware behaviour the fixture surfaced

`runWavePose` ends with `runStandPose(1)`, which calls `setFace("stand")`. The
real instrumented firmware emits **nothing** for it. `stand`'s frame table is
empty because `epd_bitmap_stand` is declared `__attribute__((weak))` and never
defined (`face-bitmaps.h:52`) — F3 confirmed at binary level that `nm` finds no
such symbol. `setFace()` falls back to `face_defualt_frames`, which is empty for
the same reason, so `currentFaceFrameCount` is 0 and the `if (… > 0)` guard at
`:931` means `updateFaceBitmap()` — hook 2 — is never reached.

The generator models this. The visible consequence is that the wave emits
`face wave 0` and `face idle 0` and no `face stand 0` in between. Getting this
wrong would have been an invisible one-line lie in the demo.

A test re-runs the generator with `--check` and diffs, so the fixture cannot
silently drift from `hardware-map.json` — the demo's claim to show the *real* wave
expires the moment it does.

---

## 7. Path A — proven

**Status: PASS.** It became exercisable while R7 was being written — the
`renode-platform` agent landed `emulator/renode/scripts/r3-uart-hello.resc` and
its R3 probe — and the bridge needed no changes at all to consume it.

The chain that ran:

```text
firmware/probes/r3/uart_hello.c  (compiled C, no IDF)
  -> Renode 1.16.1, esp32s2-sesame.repl, Xtensa LX7 core
  -> UART.ESP32_UART @ 0x3F400000, polled FIFO writes
  -> emulation CreateServerSocketTerminal 3456 "uartsock" false
  -> the bridge's ordinary reconnecting TCP client
  -> SesameTelemetryParser
  -> WebSocket
```

Verbatim, from the run:

```
renode: R3-READY
[bridge] uart connected to 127.0.0.1:3456
=== PATH A RESULT ===
envelopes: 10  uart events: 7
  {"type":"log","seq":0,"provenance":"observed","channel":"uart","text":"r3-uart-probe: esp32s2 uart0 mmio, no idf"}
  {"type":"protocol.hello","seq":1,"provenance":"observed","protocolVersion":1,"emitter":"sesame-lab-r3"}
  {"type":"servo.target","seq":2,"provenance":"observed","joint":"R4","angleDeg":72}
  {"type":"servo.target","seq":3,"provenance":"observed","joint":"L1","angleDeg":15}
  {"type":"face.expression","seq":4,"provenance":"observed","name":"wave","frame":0}
  {"type":"log","seq":5,"provenance":"observed","channel":"firmware","text":"renode esp32s2 uart0 up"}
  {"type":"log","seq":6,"provenance":"observed","channel":"uart","text":"r3-uart-probe: done"}
```

Every claim the architecture makes about this seam holds: an emulated CPU wrote
bytes to an emulated UART, the host read them off a TCP socket, and they arrived
as typed `servo.target` events with `provenance: observed` — legitimately
observed, because they really did cross an emulated hardware boundary. Note the
two `log` events with CRLF line endings (`\r\n` in the probe) sitting either
side of LF-terminated sentinel lines: the parser's mixed-terminator handling is
not theoretical here.

**One sequencing rule, and it is not optional.** Renode's server socket terminal
has no backlog: bytes the target writes before a client attaches are gone. The
`.resc` therefore leaves the machine **paused**, and the harness must connect the
bridge first and only then type `emulation RunFor` at the monitor. Getting this
backwards produces an empty stream and looks exactly like a broken bridge.

**Zero bridge changes were required.** The replay harness was built as a TCP
server specifically so that Path A and Path B would exercise the same client code
(§5.1); this run is the evidence that the bet paid off.

### What Path A does NOT yet show

The R3 probe is hand-written C emitting hard-coded `@SESAME` lines. It is not the
Sesame firmware. Running `s2mini-instrumented` under Renode needs R4's boot
ladder to survive `display.begin()`'s hard fail at
`sesame-firmware-main.ino:659`, and R1 already found the ESP32_UART model
implements 11 of 30 registers with an S3/C3 register layout. So Path A proves the
**transport**, not the firmware.

## 8. The contract test

`src/__tests__/contract-paths.test.ts`. Three cases, deliberately of different
strength:

| Case | Backend | Status |
|---|---|---|
| **B1** | `ReplayServer`, per-timestamp batching — the shipped Path B | pass |
| **B2a** | raw socket, the identical bytes in **one** `write()` | pass, output identical to B1 |
| **B2b** | raw socket, **one byte per write** | pass, output identical to B1 |
| **A** | **real Renode**: emulated Xtensa LX7 → ESP32_UART MMIO → socket terminal | **pass**, output identical to the same bytes via a plain socket |

```
✓ Path A — Renode emulated UART > produces byte-identical WebSocket output
  to Path B for the same telemetry [spawn]   5881ms
```

B1 == B2 on its own would only show that the bridge's output depends on the byte
stream and nothing else — necessary, but not the claim. **Case A closes it.** The
same telemetry, produced once by an emulated CPU writing UART registers and once
by `socket.end(payload)`, produces byte-identical `uart` envelope sequences. That
is what makes the backends substitutable.

Case A's expected bytes are read out of `firmware/probes/r3/uart_hello.c`'s
`lines[]` array, not retyped — the same anti-duplication discipline as §4. A
hard-coded copy in the test would agree with a typo in the probe.

**Path A is opt-in, and that is a deliberate trade.** `SESAME_PATH_A=1` spawns
Renode (~6 s for the test, ~20 s worst case to the ready banner);
`SESAME_RENODE_UART_PORT=<port>` attaches to one you already have. It is not on by
default because the checked-in `.resc` hard-codes TCP 3456, so a concurrent run
would collide on the port and report a confusing failure instead of an honest
skip. Skipped, it names the reason and the command in the test title.

```
SESAME_PATH_A=1 pnpm --filter @sesame-lab/sesame-bridge test
```

Both sides are run with the same `defaultProvenance` explicitly, because the
production defaults differ on purpose (§5.3) and comparing them would fail for a
reason that is a feature.

---

## 9. The automated end-to-end proof

`src/__tests__/bridge-e2e.test.ts`. Starts the bridge on ephemeral ports, plays
the wave fixture through a real TCP socket, connects a WebSocket client — Node's
**built-in** client, not the `ws` one the server uses, so a whole class of
protocol bug cannot hide — and asserts. No browser, no human.

What it asserts:

- Every one of the 35 fixture lines arrives as a typed event, in order, with a
  **gapless** envelope index and a **gapless** protocol `seq`.
- The 29 servo events match the fixture's `(joint, angle)` pairs exactly, and the
  L3 wave really is `180,100,180,100,180,100,180,100`. A pipeline dropping every
  other event would still have "some" servo events.
- `WAVE` and `STAND` — plain `Serial.println` text — arrive as `log`/`uart`
  events rather than being swallowed, interleaved in the right place.
- **Nothing** falls through to `protocol.unknown`.
- A replayed stream is labelled `simulated` end to end and never upgraded.
- Bridge lifecycle lands on `origin: bridge`, channel `emulator`, its own `seq`.
- A client that joins *after* the movement finished still gets the whole backlog.
- `GET /` serves the viewer, and it carries the firmware joint order;
  `GET /../../package.json` is refused.
- `stop()` releases both ports and is idempotent.

Plus `reconnect.test.ts`: the source not existing yet then appearing; the source
dying **mid-line** (those bytes were delivered — they are flushed, not dropped)
and the stream continuing with unbroken numbering across the reconnect; a viewer
dropping and getting the backlog; oldest-first eviction when the buffer is smaller
than the stream.

```
 ✓ reconnect.test.ts        (4)
 ✓ bridge-e2e.test.ts       (8)
 ✓ contract-paths.test.ts   (4 | 1 skipped)
 ✓ config-and-replay.test.ts (12)
 ✓ firmware-format.test.ts  (18)
 Tests  45 passed | 1 skipped (46)
```

With `SESAME_PATH_A=1` the skipped case runs too, and passes:

```
 ✓ contract-paths.test.ts   (4)
   ✓ Path A — Renode emulated UART > produces byte-identical WebSocket output
     to Path B for the same telemetry [spawn]   5881ms
```

`pnpm -r build`, `pnpm -r typecheck` and `pnpm -r test` are all green from the
repo root: 53 + 255 + 45 = **353 tests passing**, 1 skipped by default (Path A,
opt-in — see §8).

A live process run, as a sanity check that the tests are not testing an in-memory
fiction:

```
$ node emulator/bridge/dist/cli.js --replay …/wave-pose.replay.jsonl \
      --replay-speed 30 --serve-viewer --ws-port 8793
websocket   ws://127.0.0.1:8793/telemetry
viewer      http://127.0.0.1:8793/
[bridge] uart connected to 127.0.0.1:3468
[bridge] replay pass 1 complete
[bridge] replay complete; not reconnecting (pass --loop to repeat)
→ a WebSocket client attached afterwards received 40 envelopes, 35 of them uart.
```

---

## 10. What still needs physical hardware

Nothing below is blocked on anything but a board.

1. **The hooks have never executed.** Everything in §4 is a build-, source- and
   binary-level claim. Path A proves the *transport* with a hand-written probe,
   not these hooks: no ESP32-S2, real or emulated, has run the instrumented
   Sesame image. Specifically unverified:
   that `Serial.printf` from inside `setServoAngle()` completes within the 20 ms
   `motorCurrentDelay` budget without perturbing servo timing; and that emitting
   from `updateFaceBitmap()` — which runs re-entrantly out of `delayWithFace()`,
   itself called from `setServoAngle()` — does not deadlock or reorder.
2. **USB-CDC and the boot banner.** On the S2 Mini `Serial` is USB-CDC. Output
   printed before the host enumerates is lost. The banner sits at the end of
   `setup()` per the protocol document, which is late enough to probably survive,
   but "probably" is the accurate word. Under emulation there is no such window.
3. **Wire-rate headroom.** At 115200 baud a `servo` line is ~1.7 ms. `runDancePose`
   and `runWalkPose` issue servo writes faster than the wave does; whether any
   choreography saturates UART0 is arithmetic today and an observation only on
   silicon.
4. **The OLED hook has never run.** Its base64 encoder is correct by inspection
   (1024 = 3·341 + 1, tail byte encoded separately with one pad → exactly 1368
   characters) and its literal is verified absent from the default build, but it
   has not been enabled, compiled, or executed once.
5. **ESP32Servo 3.0.9's cross-channel write leak** (upstream's `#103`) is still
   unreproduced — F3 recorded it and honoured the pin. If it is real, it corrupts
   exactly the signal these hooks report.

---

## 11. Deliverables

| Path | What |
|---|---|
| `firmware/patches/telemetry-instrumentation.patch` | The two hooks + banner. 4 hunks, +126/-0. |
| `firmware/build/sketch.yaml` | `s2mini-instrumented` profile. |
| `scripts/build-firmware.mjs` | Profile entry + the generated-source assertions of §3.1. |
| `scripts/extract-telemetry-literals.mjs` | Literal extraction and ELF/bin cross-check. |
| `firmware/build/telemetry-literals.json` | Checked-in binary-level evidence (§4 level 2). |
| `scripts/build-replay-fixture.mjs` | Choreography → timed `@SESAME` stream, any of the 21 movements. |
| `emulator/bridge/` | The bridge, its CLI, and 46 tests (incl. the Renode Path-A driver in `src/__tests__/path-a-renode.ts`). |
| `emulator/bridge/fixtures/wave-pose.replay.jsonl` | The shipped Path-B fixture. |
| `debug-viewer/index.html` | The throwaway. |
| `reproducibility.json` | `builds[]` now has all four profiles. |

Useful commands:

```
node scripts/build-firmware.mjs s2mini-instrumented --clean
pnpm validate:telemetry-literals
pnpm validate:replay-fixture
pnpm demo:telemetry            # bridge + viewer on http://127.0.0.1:8787/
SESAME_PATH_A=1 pnpm --filter @sesame-lab/sesame-bridge test   # includes Path A
```
