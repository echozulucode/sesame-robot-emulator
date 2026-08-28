# EXP6 — the OLED experiment

**Report's experiment 6:** *"Can the SSD1306 initialization path succeed? — minimal display
sketch/mock; pass criterion `display.begin()` succeeds and pixels observable."*

**Author:** `phase0-closeout`. **Date:** 2026-08-23
**Plan:** [`docs/plans/phase-0-foundations-and-renode-research.md`](../plans/phase-0-foundations-and-renode-research.md)
**Report:** `research/Sesame Lab_ Emulator, Virtual Robot, and Interactive Engineering Learning Platform.md`

---

## 0. Why this document exists

The plan's §1 puts the report's experiments **1–7** in scope, and its definition of done requires
that each has a recorded pass/fail with evidence. But the F1–F6 / R1–R7 task breakdown **never
assigned experiment 6 to anybody**. Experiments 1, 2, 3, 4, 5, 7 and (opportunistically) 8 all
landed on a task; the OLED one fell through a hole in the plan itself. `gate-reporter` found the
hole ([`PHASE-0-SUMMARY.md`](PHASE-0-SUMMARY.md) §6 item 6) and this document closes it.

Closing it honestly means splitting the experiment into the three separable things it actually
asks, because they have three different answers:

| Leg | Question | Verdict |
|---|---|---|
| **1 · Renode** | Can `display.begin()` succeed under emulation? | **NO — and not close.** §2 |
| **2 · Instrumentation** | Is the compile-gated OLED framebuffer path real code that builds, links, routes and decodes? | **YES — proven this session.** §3 |
| **3 · Silicon** | Do real pixels appear on a real SSD1306? | **UNTESTED.** No board exists. §4 |

> **Follow-up (2026-08-28): [`EXP6-QEMU-oled.md`](EXP6-QEMU-oled.md).** Leg 2 has now been *run*,
> not only compiled — on the V1 board under Espressif QEMU, where the hook fires, the framebuffer
> arrives byte-identical to `drawBitmap(face-bitmaps.h)`, and the measured cost is **+14 ms per
> frame / +1.0 % on a full `rn wv`**, because QEMU's UART0 is a TCP socket and §3.7's 120 ms is a
> statement about 115200 baud. The in-source default here is still `0` and legs 1 and 3 below are
> unchanged: `s2mini-oled` remains unexecutable (no `esp32s2` machine) and no real panel exists.

The report's literal pass criterion — *`display.begin()` succeeds and pixels observable* — is
**NOT MET**. Leg 1 is a hard no and leg 3 has never been attempted. What leg 2 buys is that the
*educational* payload the experiment was reaching for — a framebuffer on the wire, decodable into
128×64 pixels in a browser — exists and is exercisable, without a booting SoC.

**Evidence labels:** `[RAN]` verified by running on this machine this session · `[SRC]` read from
a file on this machine · `[INFER]` reasoned, not observed.

---

## 1. What the firmware actually does at this point

`[SRC]` `firmware/upstream/firmware/sesame-firmware-main.ino` at the pinned commit
`401730514cefed738710d22303e84b0dcd6b76d0`:

```c
652  void setup() {
653    Serial.begin(115200);
654    randomSeed(micros());
656    Wire.begin(I2C_SDA, I2C_SCL);          // bootOrder step 3
659    if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {   // bootOrder step 4
660      Serial.println(F("SSD1306 allocation failed."));
661      while (1);                            // <- the whole robot stops here
662    }
```

From `hardware/hardware-map.json`: `display.begin()` is **step 4 of the 20-step `bootOrder`**,
carries `bootBlocker: true`, and the panel is an **SSD1306 128×64 at I²C `0x3C`** with
`OLED_RESET = -1`. `busClockHz` is `null` — there is no `Wire.setClock()` anywhere in the tree, so
the bus runs at whatever the pinned Arduino-ESP32 core defaults to (F4; `README.md:164`'s 400 kHz
claim is unsupported).

The important structural fact: **this is not a degradable failure.** There is no `else`, no retry,
no headless mode. A robot whose OLED does not initialise never reaches Wi-Fi, never reaches the
HTTP server, never attaches a servo, never enters `loop()`.

---

## 2. Leg 1 — under Renode: **NO**

This is answered by R4 and no boot probe was re-run for this document. R4's evidence, restated
with its provenance:

| Fact | Source |
|---|---|
| **0 of the 20 `bootOrder` steps are reached**, in every configuration tried — authoritative or diagnostic. `setup()` is never entered | R4 §4 `[RAN]`, Gate A §3.1 |
| Both the real Sesame ELF and a three-line minimal Arduino sketch **abort on instruction #0** — `entry a1,N` at `0x40025738` with `PS.WOE = 0` and no boot ROM to have set it | R4 §2, §4 `[RAN]` |
| The furthest any rung walks (rung E, `[DIAG]`, carrying a non-authoritative RAM-backed MMIO shim) is **34 ESP-IDF startup functions**, all inside `call_start_cpu0`'s prologue. It never reaches `system_early_init`, `start_cpu0`, FreeRTOS, `app_main`, `loopTask` or `setup()` | R4 §4, Gate A §3.2 `[RAN]` |
| **No ESP32 I²C controller model exists in Renode.** 24 I²C controller models ship; none has the ESP32 register layout. Priced at **3–5 d** | R1 §6, R4 §9.2 item 18 |
| **No SSD1306 device model exists in Renode.** Zero `SSD1306` strings in the 289 MB distribution. Priced at **2–3 d** | R1 §6 `[FILE]`, R4 §9.2 item 19 |

So the experiment is blocked three times over, in this order:

1. **The SoC below it does not exist.** ≈16–25 engineering days of register-level modelling stand
   between a Renode ESP32-S2 platform and user `setup()` (R4 §9.1 as corrected; Gate A §4.2).
   `display.begin()` sits *above* all of it — 34 startup functions and 20 boot steps away.
2. **The bus underneath it is not modelled** (+3–5 d).
3. **The device on that bus is not modelled** (+2–3 d).

> ### Leg 1 verdict: **NOT RUN, and unreachable — a definite NO at today's cost.**
> Total to make the report's literal experiment 6 runnable under Renode: **≈21–33 engineering
> days** (≈16–25 d to `setup()`, +3–5 d I²C, +2–3 d SSD1306), and it buys one boot step.
> Gate A's recommendation stands: keep this on the research track, off Phase 1's critical path.

Gate A §3.3 makes the same point from the other direction and is worth quoting, because it is the
single most useful sentence about this experiment: *"the plan's R4 description expected serial →
`Wire.begin` → `display.begin()` → Wi-Fi → server → servo attach. That ladder is above the one that
binds."*

**Note on the emulator's OLED panel:** `debug-viewer/index.html` renders a 128×64 grid, and
`@sesame-lab/sesame-protocol` has a full `oled.frame` type with a page-order decoder and tests.
Neither is evidence about `display.begin()`. They are the *consumer* of leg 2.

---

## 3. Leg 2 — the instrumentation hook: **YES**, proven this session

### 3.1 What was untested, and why it mattered

`firmware/patches/telemetry-instrumentation.patch` contains a second hook inside
`updateFaceBitmap()` that base64-encodes `display.getBuffer()` — the exact 1024 bytes
`display.display()` shifts into SSD1306 GDDRAM — and emits `@SESAME oled b64 <payload>`. It ships
disabled:

```c
#ifndef SESAME_TELEMETRY_OLED
#define SESAME_TELEMETRY_OLED 0
#endif
```

because one frame is **1386 bytes on the wire, ≈120 ms at 115200 8N1** `[RAN]` — six times the
20 ms `motorCurrentDelay` budget it would be emitted inside.

Every check in the repository asserted this hook's **absence**: `scripts/build-firmware.mjs` fails
the build if the source default is not `0`, and `scripts/extract-telemetry-literals.mjs` records
`@SESAME oled b64 %s\n` as `compileGated: true, expectedInBinary: false` and verifies it is not in
the ELF or the `.bin`. All of that proves the *gate* works. **None of it says anything about the
code behind the gate**, which — until this session — no compiler had ever seen. Gate B §4 item 6
records it plainly: *"has never been enabled, compiled or executed."*

That is the same shape of blind spot as the USB-CDC defect in §5.2 of the phase summary: a check
that can only observe absence cannot observe correctness.

### 3.2 What was done

A new build profile, `s2mini-oled`, identical to `s2mini-instrumented` in every respect — same
FQBN, same core 3.3.11, same pinned libraries, same board options, same patch — except for one
token: `-DSESAME_TELEMETRY_OLED=1`, injected via `compiler.cpp.extra_flags`. The patch's own
`#ifndef` makes that override legal without touching the checked-in default, so **the in-source
default is still `0` and the existing guard still passes**. One `-D` is the entire difference,
which is what makes the cost delta attributable.

```
node scripts/build-firmware.mjs s2mini-oled --clean     # produces the artifacts
node scripts/verify-oled-hook.mjs                       # pnpm verify:oled-hook
```

### 3.3 It compiles and links `[RAN]`

```
[patch] applied telemetry-instrumentation.patch (sha256 c35989c5811298d6...)
[verify] OK  board=s2-mini servoPins=[1,2,4,6,8,10,13,14] SDA=33 SCL=35
[telemetry] OK  4 @SESAME literals, hooks in place, OLED hook disabled, port=Serial0
[build] OK in 130.8s
```

(*"OLED hook disabled"* is the source-level assertion, which is still true and must stay true.)

Symbols present in the linked ELF that are absent from every other profile `[RAN]`:

```
3f012bd4 d _ZZL14sesameEmitOledPKhE3B64     # the 64-char base64 table
3ffc9e6c b _ZZL14sesameEmitOledPKhE4line    # static char line[1369]
3ffc9e68 b _ZZL14sesameEmitOledPKhE6lastMs  # the throttle timestamp
```

`sesameEmitOled()` itself has no symbol — GCC inlined it into `updateFaceBitmap()` at `-Os`.
The disassembly confirms the whole body survived, in order `[RAN]`:

```
40084633:  l32r  a8, (4013705c <Adafruit_SSD1306::getBuffer()>)   # the real framebuffer
40084636:  callx8 a8
4008463e:  call8 40095810 <millis>
4008464b:  movi  a11, 0x1f3                                       # 499 == the 500 ms throttle
4008465a:  l32r  a11, (3f012bd4 <...E3B64>)                       # base64 table
40084665:  l8ui  a8, a14, 0                                       # the 3-byte group loop
400846cd:  movi.n a8, 61                                          # '=' tail padding
400846d5:  l32r  a11, (3f000546)                                  # "@SESAME oled b64 %s\n"
400846e0:  or    a10, a5, a5                                      # a5 = Serial0 (loaded @4008461c)
400846e3:  call8 400925cc <Print::printf>
400846e6:  call8 40091854 <Adafruit_SSD1306::display()>            # frame still reaches the glass
```

### 3.4 Literal control, both directions `[RAN]`

| Profile | `@SESAME oled b64 %s\n` in `.elf` | in `.bin` |
|---|---|---|
| `s2mini` (stock) | **absent** | **absent** |
| `s2mini-instrumented` (default) | **absent** | **absent** |
| `s2mini-oled` (`-D…=1`) | present, offset `0x1546` | present, offset `0x546` |

A gate that has only ever been observed closed is not known to open. It is now observed doing both.

### 3.5 Routing `[RAN]`

The OLED `printf` call site was resolved with the same backward-dataflow argument resolver that
caught the USB-CDC mis-routing (`scripts/lib/xtensa-call-args.mjs`):

```
call site 0x400846e3   format = 0x3f000546   port = Serial0
```

**Exactly one** call site, and its `this` pointer is `Serial0` — unconditionally UART0 — not
`USBSerial`. The frame would leave through the transport R3 proved and the bridge reads.

### 3.6 Cost `[RAN]`

Section sizes from `xtensa-esp32s2-elf-size -A`, `s2mini-oled` minus `s2mini-instrumented`:

| Section | Delta | What it is |
|---|---:|---|
| `.dram0.bss` | **+1 376 B** | `static char line[1369]` + `lastMs`, rounded to alignment. **This is RAM** |
| `.flash.text` | +220 B | the inlined base64 loop and throttle |
| `.flash.rodata` | +88 B | the 64-byte alphabet + the format string |
| **Flash total** | **+308 B** | |
| **RAM total** | **+1 376 B** | |

Against the stock `s2mini` build the instrumented + OLED total is **+10 332 B flash / +1 376 B
RAM**; ~9.7 KB of the flash is `Serial0.begin()` pulling in the UART0 driver a CDC-on-boot build
otherwise never links (Gate B §2 link 3), and only ~660 B is instrumentation.

App-slot occupancy: **1 130 922 of 1 310 720 B = 86.28 %**, leaving **179 798 B (13.72 %)** free —
308 B tighter than the instrumented build. Gate B §6 item 5's "~1.4 KB of `.bss`" is confirmed at
1 376 B, which is why this is a compile flag and not a runtime one.

### 3.7 It round-trips into a typed event `[RAN]`

`scripts/verify-oled-hook.mjs` deliberately types **none** of the wire contract:

- the format string is read out of the ELF at its located offset;
- the 64-character base64 alphabet is read out of the ELF at the `…E3B64` symbol address and
  asserted to be RFC 4648 — so a firmware typo in the table would fail here rather than agree with
  a copy of itself;
- the encoder is a transcription of the patch's own C loop (341 whole 3-byte groups then the
  deliberate one-byte tail, because 1024 = 3·341 + 1) using that ELF-read alphabet;
- the decoder is the real `SesameTelemetryParser` from `@sesame-lab/sesame-protocol`, fed the
  1386-byte line in three chunks split mid-payload, because a UART stream splits mid-line.

Result:

```
rendered wire line: 1386 bytes (120 ms at 115200 8N1)
round trip: oled.frame 128x64, 1024 B decoded, 9/9 probe pixels lit, byte-identical
```

Asserted: exactly one event; `type: 'oled.frame'`; `width` 128 and `height` 64; the payload is
1368 base64 characters; the decoded buffer is **byte-identical** to the frame encoded; and nine
probe pixels chosen to straddle every page boundary and both ends of a byte
(`(0,0) (127,0) (0,63) (127,63) (3,9) (64,7) (64,8) (17,32) (126,62)`) all read back lit with no
extras — `lit == 9` over the full 8 192-pixel sweep.

The **GDDRAM page ordering** is asserted against the documented formula rather than against the
helper that implements it: pixel `(3, 9)` must live in byte `3 + (9>>3)·128 = 131`, bit `9 & 7 = 1`
counting from the LSB, and `frame[131] & 0b10` is checked directly. That is the layout
`Adafruit_SSD1306::drawPixel` writes and `display.display()` shifts out verbatim, so the firmware
emitter is a base64 and nothing else — no transpose, no bit reversal, no second 1 KB buffer on a
device with 180 KB of headroom.

Negative control: a truncated payload parses to `protocol.unknown` with `reason: 'bad-payload'`,
not to a silently zero-padded frame.

### 3.8 Determinism `[RAN]`

The profile inherits F3's determinism machinery, and it holds. Two full `--clean` rebuilds
(fresh scratch sketch, wiped `arduino-cli` build cache) produced byte-identical output `[RAN]`:

| Artifact | Bytes | SHA-256 | Run 2 |
|---|---:|---|---|
| `sesame-firmware-main.ino.elf` | 15 525 068 | `d61fea9fe38b2f531f4181a3339e89c9cca5360f1de3b5d4cd849f9b5bbcfbda` | **identical** |
| `sesame-firmware-main.ino.bin` | 1 131 072 | `38ff00f50c626894c9af4a8b08f130045db19a312a85efa138849e7b09245995` | **identical** |
| `sesame-firmware-main.ino.map` | 18 136 471 | `8ca255b778fcccfcf4bf27d3edf77f6fdf62f4b39a0080baf5f68130f32b27fb` | **identical** |

Recorded in `reproducibility.json` alongside the other four profiles. F3's caveat carries over
unchanged: this is **same-machine** reproducibility — the absolute build path is embedded in DWARF
and assert strings.

> ### Leg 2 verdict: **PASS.** The hook is real code. It compiles, links, keeps its symbols,
> reads the genuine `Adafruit_SSD1306` framebuffer, emits to UART0, and decodes into a correct
> 128×64 `oled.frame`. **The default stays `0`** — this proves the path works, it does not enable
> it.

---

## 4. Leg 3 — real pixels on real glass: **UNTESTED**

Nothing here has run on an ESP32. There is no board. Specifically unverified, and none of it is
inferable from a binary:

1. **That `display.begin()` succeeds on the actual hardware at all.** The `while (1);` at `:661`
   makes this the single highest-consequence unknown in the firmware.
2. **That the emitted frame matches the glass.** The hook reads `getBuffer()` *before*
   `display.display()`, so it reports the frame about to be pushed. If an I²C write fails, the
   telemetry says the frame was drawn and the panel disagrees. Telemetry here is a claim about the
   driver's intent, never a readback of the panel.
3. **Timing.** 120 ms per frame inside `updateFaceBitmap()`, which is itself re-entered from
   `delayWithFace()` inside `setServoAngle()`. The 500 ms throttle bounds the rate but not the
   stall: any frame that does emit blocks the servo loop for six `motorCurrentDelay` budgets.
   **This is why the hook ships off, and silicon may show it is worse than arithmetic suggests.**
4. **Re-entrancy.** Whether emitting 1386 bytes from inside a face render, from inside a servo
   delay, reorders or deadlocks anything (Gate B §4 item 3).
5. **The real I²C bus clock**, still `null` — `hardware-map.json → display.busClockHz`.

Closing 1–4 needs one Lolin S2 Mini, one flash of `s2mini-oled`, and one afternoon. It is part of
P1-0 in the phase summary's ordering, which is already the highest evidence-per-day item in the
programme.

---

## 5. Verdict against the report's pass criterion

> *"pass criterion `display.begin()` succeeds and pixels observable"*

**NOT MET.** Stated without hedging:

- `display.begin()` has **never been executed** — not under Renode (it is 34 startup functions and
  ≈16–25 d of SoC modelling below the reachable frontier, then +5–8 d of I²C and SSD1306 modelling
  above it), and not on silicon (there is no board).
- **No pixel has been observed on any panel**, real or emulated.

What *is* established, and is worth more to Phase 1 than the literal experiment would have been:

- The **exact cost** of making the literal experiment runnable under emulation: ≈21–33 d, for one
  boot step. That is a decision, not a hope.
- A **working, compiled, verified** framebuffer path from `Adafruit_SSD1306`'s own buffer to a
  typed `oled.frame` in TypeScript with the correct page-ordered geometry — the educational payload
  the experiment was reaching for, at +308 B flash and +1 376 B RAM, available the moment a board
  exists and requiring no Renode work at all.

This maps onto the phase summary's **P1-4** ("OLED path: enable the compile-gated framebuffer hook;
decode in the viewer, 2–4 d"), which is now **de-risked rather than speculative** — the firmware
half of it is built and verified, leaving the viewer wiring and a board.

---

## 6. Reproducing

```bash
node scripts/build-firmware.mjs s2mini-oled --clean   # needs the toolchain; ~130 s
pnpm verify:oled-hook                                 # all of section 3, exit 0
pnpm verify:oled-hook -- --json                       # the same as machine-readable evidence

# controls, which must keep passing unchanged:
pnpm validate:telemetry-literals                      # oled literal EXPECTED ABSENT from the default build
node scripts/build-firmware.mjs s2mini-instrumented --clean
```

`firmware/artifacts/` is gitignored; `scripts/verify-oled-hook.mjs` exits **3** with the build
command rather than failing when the artifacts are not there.

---

## 7. What this document does not say

- It does **not** say the OLED works. Leg 1 is a no and leg 3 is untested.
- It does **not** say the hook should be enabled. It costs 120 ms per frame on a 20 ms budget; the
  default is `0` and this session left it `0`.
- It does **not** re-run or re-audit R4. Leg 1 rests entirely on R4's recorded evidence and Gate A's
  audit of it; no boot probe was executed for this document.
- It says nothing about whether the *face bitmaps* are correct. Those are horizontal-scan arrays
  that `Adafruit_GFX::drawBitmap` transposes on the way in; `oled.frame` carries what reaches the
  glass, not what was authored. The two null face bitmaps (`stand`, `defualt`) in the phase
  summary §4.1 remain an upstream defect nothing here tests.
