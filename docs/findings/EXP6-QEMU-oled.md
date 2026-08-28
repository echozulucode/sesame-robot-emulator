# EXP6-QEMU — the OLED framebuffer hook, running

**Author:** `qemu-oled`. **Date:** 2026-08-28
**Predecessor:** [`EXP6-oled.md`](EXP6-oled.md) — the hook's first and only *compile*.
**Backend:** [`Q1-qemu-spike.md`](Q1-qemu-spike.md), [`Q2-qemu-backend.md`](Q2-qemu-backend.md),
[`Q3-ledc-fidelity.md`](Q3-ledc-fidelity.md).

---

## 0. The one-sentence result

The OLED pixels in the app are now **observed** rather than **inferred**: the 1024 bytes come out
of the guest's own `Adafruit_SSD1306` framebuffer over UART0, they are byte-identical to what
`Adafruit_GFX::drawBitmap` produces from `face-bitmaps.h`, and they cost **+14–15 ms per frame** —
**+1.0 % to +2.5 %** on a full `rn wv` — against the **~120 ms** 115200-baud figure that kept the
hook off. This is still the **emulator**: `isPhysicallyObserved()` stays `false`, and QEMU still models
no SSD1306.

**Evidence labels:** `[RAN]` verified by running on this machine this session · `[SRC]` read from a
file on this machine · `[INFER]` reasoned, not observed.

---

## 1. What EXP6 left open, and why it could not close it

EXP6 proved leg 2 — the hook compiles, links, keeps its symbols, reads the real `getBuffer()`,
routes to `Serial0`, and round-trips through the real parser into a byte-identical 1024-byte
page-ordered buffer. Its own verdict: *"it does not enable it"*, and its §4 listed four things a
binary cannot tell you, the first of which is whether the code ever runs.

It could not close that, because the profile it was proven on is **`s2mini-oled`**, and Q1 §12
established there is **no `esp32s2` machine in QEMU at all** — the recommended DIY board is not
executable here by any means. There was no board and no emulator that could run it.

The missing piece was therefore not the hook. It was **a V1 image carrying it**: the same elision
and serial-CLI setup as `distro-v1-esp32-cli.flash.bin` — the image `QemuSesameRobot` already boots
— plus the one `-D`.

---

## 2. The image `[RAN]`

`emulator/qemu/build-qemu-images.mjs` gained a `cli-oled` target. It is the existing `cli` recipe
verbatim — same base scratch from `distro-v1-esp32`, same `telemetry-instrumentation.patch`, same
`make-nowifi-variant.mjs --trigger none`, same `distro-v1-esp32-qemu` profile — plus two tokens
injected through `compiler.cpp.extra_flags`, which is the same lever `scripts/build-firmware.mjs`
already uses for `s2mini-oled`:

```
-DSESAME_TELEMETRY_OLED=1 -DSESAME_TELEMETRY_OLED_MIN_MS=0
```

The patch's own `#ifndef` makes both overridable, so **the in-source defaults are still `0` and
`500`**, `scripts/build-firmware.mjs`'s source guard still passes, and
`pnpm validate:telemetry-literals` still asserts the literal is absent from
`firmware/artifacts/s2mini-instrumented`. Nothing under `firmware/` changed.

```
node emulator/qemu/build-qemu-images.mjs cli-oled     # or: pnpm build:qemu-image
```

The gate is observed opening, in the artefact that actually boots `[RAN]`:

| Image | `@SESAME oled b64 %s\n` in the flash image |
|---|---|
| `distro-v1-esp32-cli.flash.bin` | **absent** (`indexOf` = −1) |
| `distro-v1-esp32-cli-oled.flash.bin` | present, offset `0x103ad` |

On `distro-v1-esp32` there is no USB peripheral, so `ARDUINO_USB_CDC_ON_BOOT` is 0, `Serial` *is*
`Serial0`, and the hook's `printf` leaves by the same UART0 socket `QemuSesameRobot` already reads.
The USB-CDC mis-routing trap that R4 found on the S2/S3 boards cannot apply here `[SRC]`.

---

## 3. It runs `[RAN]`

`emulator/qemu/probe-oled.mjs` (`pnpm probe:qemu-oled`) boots the image, retries past
ISSUE-20260823-022, and reads UART0 with per-line arrival timestamps alongside the **real**
`SesameTelemetryParser` from `@sesame-lab/sesame-protocol`.

```
[boot] OK on attempt 2
[1] fires: 7 @SESAME oled lines in the first 7405 ms of session
[2a] wire: 1386 bytes per line; socket span min 19 ms, median 21 ms, max 25 ms
```

Seven frames in seven seconds, untouched, is the `rest` face `setup()` ends with: three frames at
1 fps in `FACE_ANIM_LOOP`, redrawing itself forever. Every one of them is a real
`updateFaceBitmap()` call in the guest.

The line is **1386 bytes**, exactly as EXP6 computed from the encoder.

---

## 4. The pixels are the firmware's own `[RAN]`

This is the decisive check and it is deliberately not a comparison against anything the app
produces. The probe parses `firmware/upstream/firmware/face-bitmaps.h` itself — the header the
firmware compiled — extracts `epd_bitmap_<name>`, and applies `Adafruit_GFX::drawBitmap`'s
transformation (row-major MSB-first → page-ordered GDDRAM, set bits only, over a cleared buffer)
using the protocol package's own `setOledPixel`. `apps/web/src/generated/face-bitmaps.ts` is never
consulted: if both sides read the same generated artefact, a bug in the generator would agree with
itself.

```
[3] byte-for-byte vs drawBitmap(epd_bitmap_happy): IDENTICAL over all 1024 bytes
    across the whole session: 8/8 frames byte-identical to the authored bitmap they claim to be
```

`happy` is used for the headline check because it is a **single-frame** face: `setFace()` draws it
once and `updateAnimatedFace()` returns immediately for `currentFaceFrameCount <= 1`
(`sesame-firmware-main.ino:957`), so there is exactly one frame and no animation phase to guess at.
The whole-session check is stricter — it matches every received frame against the frame index the
firmware's own `face.expression` event reported, including the three-frame `rest` loop.

**8 of 8 identical, 0 differing bytes.** The emitter is a base64 and nothing else, on real
hardware-shaped execution, exactly as EXP6's static analysis predicted.

---

## 5. What it costs, and why EXP6's number does not transfer `[RAN]`

EXP6's concern, quoted: *"one frame is 1386 bytes on the wire, ≈120 ms at 115200 8N1 — six times
the 20 ms `motorCurrentDelay` budget it would be emitted inside."* That arithmetic is correct **and
it is arithmetic about a baud rate**. Under QEMU, UART0 is `-serial tcp:127.0.0.1:N`. There is no
115200. The question had to be re-measured, not assumed in either direction.

Two independent measurements, both against `distro-v1-esp32-cli.flash.bin` as the control — the
same image, the same commands, the same host, differing by the one `-D`.

### 5.1 Isolated per-frame cost

Twelve alternating `fc happy` / `fc sad` lines (alternating because `setFace()` early-returns on the
same name, `:904`), each fenced by the firmware's own `subtrim` completion barrier, spaced 600 ms
apart. Each line is exactly one `updateFaceBitmap()`, and the fenced time is guest work plus the
wire drain that precedes the barrier — the whole cost a consumer actually pays.

| Image | median | mean |
|---|---:|---:|
| `cli` (no hook) | 15 ms | 14.0 ms |
| `cli-oled` (`MIN_MS=500`) | 29 ms | 27.8 ms |
| `cli-oled` (`MIN_MS=0`, shipping) | 30 ms | 31.0 ms |
| `cli-oled` (`MIN_MS=0`, A/B build) | 45 ms | 39.3 ms |

> **Per frame: +14–15 ms** (29−15 and 30−15 in two separate sessions), against EXP6's **~120 ms**.
> Roughly one eighth, and **below one `motorCurrentDelay`** rather than six of them.

The last row reads high and the reason is worth stating rather than averaging away: with the
throttle off, the firmware's own idle-blink state machine (§5.3) fires additional
`updateFaceBitmap()` calls that sometimes land *inside* the fenced window, so that figure prices
more than one frame. It is an upper bound, not a contradiction — every session's *minimum* cost per
guaranteed frame lands in the same 14–15 ms band.

### 5.2 Whole-choreography cost

`rn wv` — and it must be `rn wv`, not `run wave`: the console's dispatch table has no `run wave`
entry (`:796`), so that string falls through to the `sscanf("%d %d")` arm and returns in ~5 ms
having done nothing. The abbreviation is ~30 `setServoAngle()` calls, each paying
`delayWithFace(motorCurrentDelay)`, plus five explicit `delayWithFace(200..300)`, with
`updateFaceBitmap()` re-entered from inside those delays — the exact hot path EXP6 was worried about.

| Image | `rn wv`, 4 runs | median | servo events | face frames | oled frames |
|---|---|---:|---:|---:|---:|
| `cli` | 3849, 3849, 3851, 3858 | **3851 ms** | 116 | 8 | 0 |
| `cli-oled` (`MIN_MS=500`) | 3909, 3887, 3889, 3871 | **3889 ms** | 116 | 8 | 5 |
| `cli-oled` (`MIN_MS=0`, A/B) | 3914, 3907, 3916, 3900 | **3914 ms** | 116 | 8 | 8 |
| `cli` (third session) | 4002, 3989, 3944 | **3989 ms** | 87 | 6 | 0 |
| `cli-oled` (`MIN_MS=0`, shipping) | 4089, 4207, 4084 | **4089 ms** | 87 | 6 | 6 |

> **+38 ms, +40 ms and +100 ms on ~3.9 s across three sessions — +1.0 % to +2.5 %**, for a full
> wave, with every servo event still emitted. The spread is host scheduling, not the hook: the
> run-to-run range *within* one session reaches 123 ms (4084…4207) on its own, which is why the
> isolated per-frame figure in §5.1 is the number to trust and this one is the sanity check on it.
> Either way the answer is the same order: **one percent**, not six `motorCurrentDelay` budgets.

The baseline emitted **0** oled lines across every run, which is the control that makes the delta
attributable.

### 5.3 Does `SESAME_TELEMETRY_OLED_MIN_MS` need a non-default value? **Yes: 0.**

The 500 ms throttle exists to bound *wire* cost on a 115200 UART. Measured here, it buys nothing
and costs fidelity:

```
[5] throttle @500: 8 frames drawn, 5 emitted => 3 suppressed
[5] throttle @0:   8 frames drawn, 8 emitted => 0 suppressed
```

Three of eight frames the firmware actually drew during a single wave never reached the host, so the
panel a learner watches could lag the guest by up to half a second and skip intermediate frames
outright. It is worse than that in the idle path: `enterIdle()` / `updateIdleBlink()`
(`:1011`–`:1047`) drive an `idle` ⇄ `idle_blink` animation with intervals as short as 120–220 ms,
so at 500 ms the blink is invisible more often than not. In the isolated face-set test the throttle
suppressed exactly half the frames (24 emitted unthrottled versus 12 throttled) — the missing half
being the idle-blink transitions between the commanded faces.

The cost of removing it is inside the measurement noise (+40 ms versus +38 ms on `rn wv`). So the
shipping image is built with `-DSESAME_TELEMETRY_OLED_MIN_MS=0`, and the in-source default stays
500 for silicon, where the 120 ms figure is real and the throttle is doing its job.

---

## 6. What changed in the capability record

`packages/sesame-qemu/src/config.ts`. **The app is capability-driven** — `App.tsx:809` gates the
"these pixels did not come from the emulator" message on `!oledFramebuffer ||
elided.includes('ssd1306-panel')`, and `apps/web/src/oled/pixel-provenance.ts` keys on the same two
fields — so this is the change that flips the message, with nothing in the app hardcoded.

| Field | Before | After (default image) |
|---|---|---|
| `DEFAULT_IMAGE_PATH` | `distro-v1-esp32-cli.flash.bin` | `distro-v1-esp32-cli-oled.flash.bin` |
| `oledFramebuffer` | `false` | **`true`** |
| `elided` | includes `ssd1306-panel` | `ssd1306-panel` removed, **`ssd1306-glass` added** |
| `firmwareDeviations` | 3 entries | 4 — the `-D` pair is a firmware change and is declared as one |
| `PERIPHERAL_FIDELITY` | 1 entry (LEDC) | 2 — the SSD1306 paragraph in §7 |

**The record is a property of the image, not of the backend.** `capabilitiesForImage()`,
`originForImage()` and `elidedForImage()` derive from the resolved `imagePath`, so booting
`distro-v1-esp32-cli.flash.bin` still reports `oledFramebuffer: false` with `ssd1306-panel` elided
— the old answer, still correct for that image. An unrecognised image gets the conservative answer,
which is the safe direction to be wrong in: it under-claims rather than presenting host-drawn pixels
as the emulator's. `honesty.test.ts` pins **both** directions.

### Why `ssd1306-glass` replaces `ssd1306-panel` rather than the entry simply vanishing

`elided` means "silence from this means nothing". With the hook on, silence on `oled.frame` *does*
mean something — it means `updateFaceBitmap()` was not called, which is exactly what the firmware
does for a face with no bitmap (ISSUE-20260823-004). So `ssd1306-panel` had to go. But the **device**
is still absent, and dropping the entry outright would have quietly dropped that fact too.
`ssd1306-glass` carries it: no pixel has been confirmed to reach any panel, emulated or real.

---

## 7. What stays honestly unproven, and always will under emulation

The OLED now sits in exactly the awkward middle the LEDC occupies (Q3), and for the same reason:
**the evidence is a firmware hook above a peripheral the emulator does not have.**

1. **QEMU still models no SSD1306.** The only I2C slave the `esp32` machine creates is a TMP105.
   `display.display()`'s writes go nowhere. `oledFramebuffer: true` is a claim about the
   *framebuffer*, never about the panel.
2. **The hook reads `getBuffer()` *before* `display.display()`.** It reports the frame the driver
   was about to shift out. If an I2C write failed, the telemetry would still say the frame was
   drawn and a panel would disagree. Telemetry here is the driver's intent, never a readback.
   Unchanged from EXP6 §4 item 2 — and unchangeable from inside an emulator.
3. **`display.begin()` still means nothing here.** The image runs it, but with no device on the bus
   the return value is not evidence about a real SSD1306 at `0x3C`. The report's literal experiment-6
   pass criterion — *"`display.begin()` succeeds and pixels observable"* — is **still not met** on
   its first half. The second half is now met for the emulator, and only for the emulator.
4. **Not hardware.** `origin.kind` is `emulator`, `origin.board` is `distro-v1-esp32`, and
   `isPhysicallyObserved()` returns `false` for every event on this transport including
   `oled.frame`. Provenance moved `inferred → observed`; origin did not move at all. A test
   (`honesty.test.ts` → *"enabling the framebuffer moves NOTHING towards hardware"*) exists purely
   to keep it that way.
5. **The board this runs on is not the board anyone is told to buy.** `distro-v1-esp32` only. No
   `esp32s2` machine exists, so `s2mini-oled` — the profile EXP6 compiled — remains unexecutable.
6. **The face bitmaps themselves are not validated by any of this.** `oled.frame` carries what
   reaches the glass, not whether it was authored correctly. The two null face bitmaps (`stand`,
   `defualt`) remain an upstream defect nothing here tests.

---

## 8. Reproducing

```bash
node emulator/qemu/build-qemu-images.mjs cli-oled     # pnpm build:qemu-image, ~4 min
node emulator/qemu/probe-oled.mjs --json              # pnpm probe:qemu-oled; exit 0 = pixels match
node emulator/qemu/probe-oled.mjs --face rest         # a three-frame animated face instead

# controls, which must keep passing unchanged:
pnpm validate:telemetry-literals   # the literal is still ABSENT from firmware/artifacts
pnpm verify:oled-hook              # EXP6's static proof, untouched
pnpm --filter @sesame-lab/sesame-qemu test
```

`probe-oled.mjs` exits **3** with the build command when the image is not there, and **1** if any
received frame differs from the authored bitmap. `emulator/qemu/images/` is gitignored.

Boot flake is ISSUE-20260823-022, not this work: 4 of the 8 boots in these measurements needed a
retry, all with `Guru Meditation Error` inside `nvs_flash_init`, all recovered on the next attempt.

---

## 9. What this document does not say

- It does **not** say the OLED panel works. The device is not modelled and never has been.
- It does **not** say the hook should be enabled on silicon. On a real 115200 UART the 120 ms figure
  is real, six `motorCurrentDelay` budgets is real, and the in-source default is still `0`.
- It does **not** retire EXP6. EXP6's leg 1 (Renode: no, at ≈21–33 d) and leg 3 (silicon: untested,
  no board) are unchanged. This closes the gap between them for one emulator and one board.
