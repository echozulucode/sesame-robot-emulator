# Gate B — servo extraction

**Gate question:** *Can a servo target be captured deterministically?*

**Author:** `gate-reporter` — independent synthesis. This agent performed none of R5–R7; it read
their findings, re-verified the load-bearing claims against source and artifacts, and audited the
claim chain.
**Date:** 2026-08-23 · **Plan:** `docs/plans/phase-0-foundations-and-renode-research.md` §6

---

## 0. Answer

> ### **YES — via instrumented firmware.**
> Verified at source, patch, binary, disassembly and transport level. **Never executed on
> physical silicon, and never executed as a complete image under emulation.**

The gate asks which of two routes works. Both were in scope for the phase as a question; only one
was in scope as work.

| Route | Status | Evidence |
|---|---|---|
| **Instrumented firmware** — hook `setServoAngle()` | **WORKS.** This is the answer | R6 §2–§4; independently re-verified below |
| **Emulated peripheral** — model LEDC/PWM and decode duty → pulse width → angle | **UNPROVEN AND UNTOUCHED.** No LEDC model exists in Renode (0 `LEDC` strings in the 289 MB binary; no generic PWM either), and nothing above the CPU line boots. Priced by R4 at **3–5 d** for the LEDC model, behind ≈16–25 d of prerequisite SoC work | R1 §6, R4 §9.2 item 17 |

The report's Gate-B decision tree was *"YES → feed common telemetry; NO → instrument
`setServoAngle()`"*. Phase 0 inverted it deliberately and correctly: instrumentation was made
primary because it is cheap, unblocks everything, and — critically — it produces **exactly the
same wire protocol** the emulated peripheral would eventually produce, so the eventual swap is a
deletion rather than a rewrite.

---

## 1. Evidence labelling

`[RAN]` verified by running · `[SRC]` read from a file on this machine · `[INFER]` reasoned.
Items marked **`[GR]`** were re-verified independently by this agent rather than taken from R6/R7.

---

## 2. The claim chain, audited link by link

Gate B's answer rests on a five-link chain. Any broken link invalidates the gate, so each was
checked separately.

### Link 1 — there really is a single convergence point `[GR]` `[RAN]`

R6 claims all servo motion converges on `setServoAngle()`. This agent verified it directly
against the pinned firmware rather than accepting it:

```
$ grep -n "servos\[\|\.write(" reference/sesame-robot-main/firmware/*.ino *.h
sesame-firmware-main.ino:99:    Servo servos[8];
sesame-firmware-main.ino:740:   servos[i].setPeriodHertz(50);
sesame-firmware-main.ino:742:   servos[i].attach(servoPins[i], 732, 2929);
sesame-firmware-main.ino:1054:  servos[channel].write(adjustedAngle);       <- the only write
```

**Exactly one `Servo::write()` call site exists in the entire firmware tree**, inside
`setServoAngle()`. There is no bypass path. The claim holds unconditionally, not statistically.

The hook is placed **after** the clamp at `:1053` and **before** `delayWithFace()` at `:1055`:

```c
int adjustedAngle = constrain(angle + servoSubtrim[channel], 0, 180);
servos[channel].write(adjustedAngle);
sesameEmitServo(channel, adjustedAngle);      // <- hook
delayWithFace(motorCurrentDelay);
```

Both halves of that placement are load-bearing and both were derived from F4, not guessed:
after the clamp means the reported number is the one the servo library received, subtrim
included; before `delayWithFace()` means the servo event is not reported *later* than face
changes it actually preceded, because F4 established that `delayWithFace()` is a re-entrancy
point that pumps `updateAnimatedFace()`, `server.handleClient()` and
`dnsServer.processNextRequest()` and can itself emit telemetry.

### Link 2 — it covers the movement corpus `[GR]` `[RAN]`

R6 states "all 21 movement functions and all 223 servo steps route through it". This agent
recomputed from `hardware/hardware-map.json` by walking every nested `repeat`/`conditional`/`call`:

```
TOTAL servo steps 223 | functions containing servo steps 19 of 21 | 395 steps total
```

**The 223 figure is exact and the coverage is total. The "21 movement functions" phrasing is
mildly overstated** — `enterIdle` and `exitIdle` contain no servo steps at all (they are face and
state functions), so 19 of the 21 emit servo telemetry and 2 emit none by construction. Nothing
escapes the hook; the wording just implies more than it delivers. Recorded, not a defect.

Also verified: no angle anywhere in the corpus is computed at runtime — all 223 are literal
integers — which is why the instrumented stream is *predictable* as well as observable.

### Link 3 — the build is reproducible `[RAN]` `[GR]`

The `s2mini-instrumented` profile builds through F3's machinery, same FQBN, same core 3.3.11,
same pinned libraries, so the only difference from stock is the patch.

| Artifact | SHA-256 | Reproduced |
|---|---|---|
| `.elf` (15 523 320 B) | `7c3fd85a47ebbdacc3000d59b9b0ef39d443245c81ce84a26f6b31a79e92331f` | byte-identical across a full `--clean` rebuild, 2 runs |
| `.bin` (1 130 768 B) | `d65504cc839697f2fdb739ac544c343b1d72558e40f12d9ddcf28113876eb703` | byte-identical |

`[GR]` This agent re-hashed the on-disk ELF: `7c3fd85a…92331f`. It matches R6 and
`reproducibility.json`.

Cost: **+10 024 bytes flash (+0.77 pt of the 1.2 MB app slot), +0 bytes RAM.** The honest
breakdown matters: only ~356 bytes is the instrumentation. The other ~9.7 KB is
`Serial0.begin()` pulling in the UART0 driver that a CDC-on-boot build otherwise never links —
the price of having a transport at all, paid in flash rather than RAM. 180 106 bytes (13.7 %) of
the app slot remain free.

**Determinism, precisely.** "Deterministic" here means three separate things and only two are
proven: (a) the *binary* is bit-for-bit reproducible — proven; (b) the *emitted value* is the
post-subtrim, post-clamp integer that reached `Servo::write()`, so it cannot drift from what the
servo was told — proven by construction and by disassembly; (c) the *timing* of emission relative
to the servo write is fixed — proven at instruction level, **not** proven under real execution,
where `Serial0.printf` must complete inside the 20 ms `motorCurrentDelay` budget without
perturbing servo timing. (c) needs silicon. See §4.

### Link 4 — the wire format is verified against the parser, at source *and* binary level `[RAN]`

This is the strongest part of the work and the part most worth copying elsewhere. The obvious
test — `expect(parse('@SESAME servo R4 72')).toMatchObject(...)` — verifies nothing about the
firmware: if the C literal said `@SESAME srvo`, two copies of the same typo would agree
perfectly. **No `@SESAME` string is typed anywhere in the verification.**

| Level | What it reads | What it proves |
|---|---|---|
| 1 · patch → parser | Only lines the patch *adds*; extracts every `@SESAME…` C literal by regex, unescapes, renders through a small `printf`, feeds the real `SesameTelemetryParser`. Fuzzes the servo stream at **every single byte offset** | The literal the firmware carries decodes to the intended event. Runs on a clean clone with no toolchain |
| 2 · patch → checked-in evidence | `firmware/build/telemetry-literals.json` must still equal the patch's literal set | The committed evidence cannot rot while looking authoritative |
| 3 · patch → built binary | The three literals present at verifiable offsets in both `.elf` and `.bin`; `@SESAME oled b64 %s\n` verifiably **absent** (compile-gated); control check that the **stock** `s2mini` ELF contains no `@SESAME` bytes at all | The bytes survived the compiler |
| 4 · patch → the port at the call site | An Xtensa `call8` argument resolver walks `l32r`/`mov.n`/`or` backwards to the `this` pointer at each of the three telemetry call sites | The bytes go somewhere useful. **Levels 1–3 all passed on a build that emitted to USB CDC** — see §3 |

`[GR]` Re-run this session: `pnpm validate:telemetry-literals` → *4 literals, up to date*;
`pnpm -r test` → **368 passed, 1 skipped** (the skipped case is Path A, opt-in via
`SESAME_PATH_A=1`). Artifact-dependent assertions correctly `skipIf` when
`firmware/artifacts/` is absent, so a clean clone passes with fewer real checks rather than
silently claiming them.

### Link 5 — the transport is observed end to end `[RAN]`

```text
firmware/probes/r3/uart_hello.c  (real xtensa-esp32s2-elf-gcc 14.2.0 output, no IDF)
  → Renode 1.16.1, esp32s2-sesame.repl, Xtensa LX7 esp32s2 core
  → UART.ESP32_UART @ 0x3F400000, polled FIFO writes
  → emulation CreateServerSocketTerminal 3456 "uartsock" false
  → the bridge's ordinary reconnecting TCP client
  → SesameTelemetryParser → WebSocket
```

Output, verbatim from the run:

```json
{"type":"servo.target","seq":2,"provenance":"observed","joint":"R4","angleDeg":72}
```

An emulated CPU wrote bytes to an emulated UART; the host read them off a TCP socket; they arrived
as a typed `servo.target` with `provenance: observed` — legitimately observed, because they really
did cross an emulated hardware boundary. **Zero bridge changes were required**, which was the
point of building the replay harness as a TCP server rather than a file reader.

The contract test closes it: the same telemetry produced once by the emulated core and once by
`socket.end(payload)` yields **byte-identical** WebSocket envelope sequences (cases A vs B2a vs
B2b, including a one-byte-per-write case). That is what makes the backends substitutable.

**What link 5 does not show:** the R3 probe is hand-written C emitting hard-coded `@SESAME` lines.
It is not the Sesame firmware. Link 5 proves the **transport**; links 1–4 prove the **hooks**.
Nothing yet joins them.

---

## 3. The defect this gate nearly shipped, and why it matters to the answer

The first version of R6 **was wrong**, and every check R6 had was structurally blind to it.

Arduino-ESP32 resolves `Serial` at compile time. On the `s2mini` profile
(`-DARDUINO_USB_CDC_ON_BOOT=1 -DARDUINO_USB_MODE=0`), `Serial` is `USBSerial` — a TinyUSB CDC
endpoint on the S2's USB-OTG peripheral — **not** UART0. The instrumented firmware compiled,
linked, carried all three format strings at verifiable offsets, passed levels 1–3 of §2 link 4 —
and emitted every byte to a transport the bridge does not read and Renode does not model.

```
40085522:  call8 <Print::printf>
4008551d:  l32r  a10, ... (3ffc9f64 <USBSerial>)   <- the defective build
400854e5:  l32r  a10, ... (3ffca168 <Serial0>)     <- the fixed build
```

Routing truth for the three shipped profiles, read from each build's real flags and confirmed with
`nm`: `s2mini` → `USBSerial` (no), `distro-v3-s3` → `HWCDCSerial` (no), `distro-v1-esp32` →
`Serial0` (yes — and only because the original ESP32 has no USB peripheral at all, which is luck,
not design).

**It was found by a different agent** (`renode-boot`, while costing USB-CDC modelling) reading
`firmware/artifacts/s2mini/build-manifest.json`. Fixed by naming the port —
`#define SESAME_TELEMETRY_PORT Serial0`, which is unconditionally UART0 on every target — rather
than by flipping a board menu option, so the routing is a property of the instrumentation instead
of a setting anyone can change without suspecting telemetry depends on it. The sketch's own
`Serial.print` keeps going to USB CDC, so the developer's serial monitor survives.

Why this belongs in the gate report rather than only in R6: **it is the difference between
"telemetry is correct" and "telemetry is delivered", and only one of those answers Gate B.** The
regression guard now asserts the *routing decision*, and — because a check that has never failed
is not known to work — the resolver is pinned against verbatim captured disassembly of the
defective build and must report `USBSerial` for it.

---

## 4. What has never run on physical silicon

**Nothing in this gate's answer has been executed on an ESP32.** No board was available; F3 flashed
nothing. The instrumented image has also never run as a complete image under emulation, because
that needs Gate A's boot ladder. Specifically unverified:

1. **The hooks have never executed.** Every claim in §2 links 1–4 is a source-, patch-, binary- or
   disassembly-level claim.
2. **Timing.** That `Serial0.printf` from inside `setServoAngle()` completes within the 20 ms
   `motorCurrentDelay` budget without perturbing servo timing.
3. **Re-entrancy.** That emitting from `updateFaceBitmap()` — which runs re-entrantly out of
   `delayWithFace()`, itself called from `setServoAngle()` — does not deadlock or reorder.
4. **UART0 sharing.** Whether the ROM/IDF console on a real S2 interleaves its own bytes with
   telemetry on the same wire. The parser survives it by design (non-sentinel text becomes
   `log`/`uart` events) but it has not been observed. Related: whether GPIO 43/44 are physically
   broken out on the Lolin S2 Mini in use.
5. **Wire-rate headroom.** ~1.7 ms per `servo` line at 115200 baud. `runDancePose` and
   `runWalkPose` issue writes faster than the wave fixture does; whether any choreography
   saturates UART0 is arithmetic today, an observation only on silicon.
6. **The OLED framebuffer hook** has never been enabled, compiled or executed. Its literal is
   verifiably absent from the default build — which is the proof the compile gate works, and also
   the proof it is untested.
7. **ESP32Servo 3.0.9's cross-channel write leak** (upstream issue #103) is unreproduced. F3
   honoured the pin without testing the claim. If the bug is real in newer versions, it corrupts
   *exactly* the signal these hooks report — which is why the pin is load-bearing for the emulator
   and not only for hardware.

---

## 5. The route Gate B did not take

The LEDC/peripheral route — the eventual *replacement* for instrumentation — is **entirely
untouched**, by design (the plan's non-goals forbid peripheral modelling in Phase 0). Its status:

- **No model exists.** R1 found zero `LEDC` strings in the 289 MB Renode binary, and no generic
  PWM model either. The only PWM models shipped are `IMXRT_PWM`, `HiFive_PWM`, `Quark_PWM`.
- **A `Python.PythonPeripheral` stub can absorb the register writes today** — R1 demonstrated one
  at the LEDC base address round-tripping a value — and for Sesame only the *duty value* is
  needed, not waveform fidelity. That is the cheap on-ramp when the time comes.
- **It is gated behind the whole SoC.** R4 prices the LEDC model at 3–5 d, but it sits behind the
  ≈16–25 d of prerequisite work Gate A describes, plus the GPIO matrix (2–3 d) and SYSTIMER
  (2–3 d) that make the duty values mean anything.
- **The protocol makes the swap free.** Both routes emit `servo.target` on the same wire format
  with the same joint names in the same firmware order. When LEDC exists, the instrumentation
  patch is deleted wholesale and the browser sees no difference except the `provenance` tag —
  which is exactly what that tag is for.

---

## 6. Recommendation

1. **Treat Gate B as answered YES and build Phase 1 on it.** The servo signal is available,
   deterministic in binary and value, and already typed at the far end of a working bridge.
2. **Close the silicon gap first thing in Phase 1.** One ESP32-S2 board, one flash of
   `s2mini-instrumented`, one afternoon closes items 1–5 of §4 and converts the strongest
   unverified claim in Phase 0 into an observation. This is the highest evidence-per-day item
   available.
3. **Keep the instrumentation deletable.** It is 4 hunks, +196/-0, with `firmware/upstream/`
   untouched. Do not let Phase-1 convenience features accrete into it; the whole design premise is
   that it disappears when LEDC arrives.
4. **Do not start LEDC modelling.** It pays off only after Gate A's backlog lands.
5. **Watch the flash budget.** The app slot is 86.3 % full at 1.2 MB. Enabling the OLED framebuffer
   hook also costs ~1.4 KB of `.bss`, which is why it is a compile flag and not a runtime one.

---

## 7. Reproducing

```bash
node scripts/build-firmware.mjs s2mini-instrumented --clean   # needs the toolchain
pnpm validate:telemetry-literals                              # patch <-> evidence <-> binary
pnpm --filter @sesame-lab/sesame-bridge test                  # 60 pass, 1 skipped
SESAME_PATH_A=1 pnpm --filter @sesame-lab/sesame-bridge test  # + real Renode Path A
pnpm demo:telemetry                                           # bridge + viewer, 127.0.0.1:8787
```
