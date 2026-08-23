# Q1 — Espressif QEMU spike (original ESP32)

**Task:** Q1 · **Date:** 2026-08-23 · **Agent:** `qemu-spike`
**Plan:** `docs/plans/phase-1-virtual-mvp.md` §3 · off the critical path, time-boxed
**Question:** *Can real Sesame firmware actually execute under Espressif's QEMU fork?*

---

## 0. The answer

> **YES.** Real, unmodified-code Sesame firmware boots through the genuine ESP32 mask ROM,
> the genuine second-stage bootloader, ESP-IDF startup and FreeRTOS, and **enters `setup()`**.
>
> Stock firmware walks **bootOrder steps 1–7 of 20** and stops inside Wi-Fi radio bring-up.
> With Wi-Fi elided, **every one of the 13 remaining steps executes**, `runWavePose()` runs,
> and real `@SESAME servo …` lines leave UART0 and are consumed by the **unmodified** Phase-0
> bridge.

For contrast, using the same 20-step ladder and the same `hardware-map.json` as its source:

| | Renode (Gate A) | Espressif QEMU (this spike) |
|---|---|---|
| Stock firmware reaches | **0 / 20** — dies on instruction #0 | **7 / 20** — dies in the radio |
| `setup()` entered | no | **yes** |
| Real `@SESAME servo` from executing firmware | no | **yes** (Wi-Fi-elided build) |
| Cost to get there | ≈16–25 engineering days, unstarted | **~0.5 day, already done** |
| Blocker class | no SoC platform exists at all | Wi-Fi only |

The blocker is now *exactly one subsystem* — the one Gate A already declared uncostable — instead
of an entire absent SoC.

### Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | **verified-by-running** on this machine; the log is committed under `emulator/qemu/logs/` |
| `[SRC]` | **found-in-source** — read out of a file or binary on this machine |
| `[INFER]` | **inferred** — reasoned, not observed |

---

## 1. What was obtained, and how

**Native Windows x86-64 binaries. WSL2 was not needed and was not used.** `[RAN]`

| | |
|---|---|
| Fork | `espressif/qemu`, release tag **`esp-develop-9.2.2-20260417`** (published 2026-04-19) |
| Asset | `qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-x86_64-w64-mingw32.tar.xz` |
| Size | 35 996 720 bytes |
| SHA-256 | `3c483d77f5350a568df1faf4d8dbc82c95d6bc2b826d0d4be910485e0a68ca2a` |
| Verified against | Espressif's own `qemu-esp_develop_9.2.2_20260417-checksum.sha256` from the same release — **not** a digest hard-coded by us |
| Version string | `QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)` |
| Installed at | `tools/qemu/qemu/` (gitignored), portable, **nothing machine-wide** |

The whole install is one `.exe` plus a `share/qemu/` directory. There is no installer, no registry
write, no PATH change and no config file — so unlike F3's arduino-cli experience there was no
machine-wide state to hunt down. Re-runnable with `node emulator/qemu/fetch-qemu.mjs`, which
re-downloads Espressif's manifest and refuses to extract on a digest mismatch.

### What the machine list says

```
$ tools/qemu/qemu/bin/qemu-system-xtensa.exe -machine help | grep -i esp
esp32                Espressif ESP32 machine
esp32s3              Espressif ESP32S3 machine
```
`[RAN]`

Two complete SoC platforms — including **ESP32-S3, the current Distro board**. There is **no
`esp32s2` machine**, which is the S2 Mini and therefore the board the report recommends for DIY
builds. §9 and §12 deal with both.

The build also ships real mask-ROM images, which R4 had to fetch and slice by hand for Renode: `[RAN]`

```
share/qemu/esp32-v3-rom.bin   esp32-v3-rom-app.bin   esp32c3-rom.bin   esp32s3_rev0_rom.bin
```

---

## 2. The flash image needed no assembly

The task anticipated having to build a flashable image from bootloader + partition table + app.
That turned out to be unnecessary: **F3 already emits a complete 4 MB flash image**,
`firmware/artifacts/<profile>/sesame-firmware-main.ino.merged.bin`, and QEMU takes it directly as
`-drive file=…,if=mtd,format=raw`.

Verified by decoding it rather than assuming: `[RAN]`

```
0x001000  e9 03 02 2f …   <- ESP image magic, second-stage bootloader
0x008000  aa 50 …         <- partition table
0x010000  e9 06 02 2f …   <- ESP image magic, application
part nvs        off 0x9000    size 0x5000
part otadata    off 0xe000    size 0x2000
part app0       off 0x10000   size 0x140000
part app1       off 0x150000  size 0x140000
part spiffs     off 0x290000  size 0x160000
part coredump   off 0x3f0000  size 0x10000
```

**One trap worth knowing: `-drive …,if=mtd,format=raw` is read-write, and QEMU writes back.** The
guest's NVS and core-dump writes land in the image file on disk, so a run silently mutates the
artefact and the next run does not start from the same flash contents. This was observed: an image
that had been booted several times no longer matched its freshly built SHA-256, purely from guest
writes. `[RAN]` Adding `snapshot=on` puts the writes in a throwaway COW overlay and leaves the file
byte-identical — verified. `[RAN]` **Any CI or lesson use of QEMU should pass `snapshot=on`.**

---

## 3. First wall — QIO flash mode (fixed, and worth recording)

The stock `distro-v1-esp32` image boots the real ROM and bootloader, then **panics before user
code**: `[RAN]` (`emulator/qemu/logs/smoke01.log`)

```
ets Jul 29 2019 12:21:46
rst:0x1 (POWERON_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)
mode:DIO, clock div:1
load:0x3fff0030,len:4876
load:0x40078000,len:16532
entry 0x400805b4
E (816) qio_mode: Failed to set QIE bit, not enabling QIO mode

assert failed: __esp_system_init_fn_init_flash startup_funcs.c:118 (flash_ret == ESP_OK)
```

QEMU's SPI-flash model does not implement the status-register **Quad-Enable** bit, so ESP-IDF's
`esp_flash` init fails and asserts. This is an emulator gap, not a firmware fault.

**The fix is one board option, and on this board it does not change the application at all.**
`boards.txt` for `esp32` reads: `[SRC]`

```
esp32.menu.FlashMode.qio.build.flash_mode=dio     <- note: dio either way
esp32.menu.FlashMode.qio.build.boot=qio
esp32.menu.FlashMode.dio.build.flash_mode=dio
esp32.menu.FlashMode.dio.build.boot=dio
```

So `FlashMode` selects only *which prebuilt second-stage bootloader is used*
(`bootloader_qio_80m` vs `bootloader_dio_80m`); the image header says DIO in both cases.
Rebuilding `distro-v1-esp32` with `FlashMode=dio` and diffing the application image against F3's
stock build confirms it: `[RAN]`

**67 differing bytes out of 1 141 552, and every one of them is accounted for. None is an
instruction.** `[RAN]`

| Offset | Bytes | What it is |
|---|---:|---|
| `0xb0`–`0xcf` | 32 | `esp_app_desc_t.app_elf_sha256` — the ELF fingerprint |
| `0x1b6e` | 1 | the ASCII board-info string `"QIO\n"` → `"DIO\n"` |
| `0x1d69` | 1 | the embedded FQBN string `FlashMode=qio` → `FlashMode=dio` |
| `0x39544` | 1 | a flash-mode enum in a config struct, `0x05` → `0x03` |
| `0x116b0f`–`0x116b2f` | 32 | trailing image SHA-256 + checksum byte |

Three metadata bytes, two hashes. The `app_elf_sha256` differs only because the ELF embeds its
absolute build path — which F3 §7 already documented as the reason its builds are
same-machine-reproducible only. Different scratch directory ⇒ different ELF hash ⇒ different
embedded fingerprint.

**Therefore: the application code booted in this spike is the same code F3 built.** Only the
bootloader binary differs. That is the claim being made, and it is the only one that is true.

---

## 4. The boot ladder — stock firmware, 7 of 20

Walked with `emulator/qemu/run-boot-ladder.mjs`, which plants a breakpoint on **the exact source
line each of F4's 20 steps is anchored to**, reading those line numbers out of
`hardware/hardware-map.json` rather than transcribing them. `[RAN]`

```
=== hardware-map.json bootOrder, walked under Espressif QEMU ===
 1  REACHED  line 652  0x400d4cff  serial    Serial.begin(115200)
 2  REACHED  line 653  0x400d4d19  rng       randomSeed(micros())
 3  REACHED  line 656  0x400d4d25  i2c       Wire.begin(I2C_SDA, I2C_SCL)
 4  REACHED  line 659  0x400d4d35  display   display.begin(SSD1306_SWITCHCAPVCC, 0x3C)
 5  REACHED  line 664  0x400d4d5c  display   OLED splash: clearDisplay / … / display()
 6  REACHED  line 674  0x400d4d8a  wifi      WiFi.persistent(false)
 7  REACHED  line 677  0x400d4d95  wifi      Station-mode branch → else: WiFi.mode(WIFI_AP)
 8     -     line 688  0x400d4da8  wifi      WiFi.softAP(AP_SSID, AP_PASS)
 …
20     -     line 749  0x400d515b  serial    Serial.println(F("HTTP server & Captive Portal started."))
--  not hit  line 661  0x400d4d58  display   while(1) after display.begin() returned false

highest bootOrder step reached: 7 / 20
```

F4's prediction that the taken branch at step 7 is the `else` (`WiFi.mode(WIFI_AP)` at line 683)
is confirmed by an independent panic backtrace resolving to `setup()` at
`sesame-firmware-main.ino:683`. `[RAN]`

### A note on how the ladder is driven

The pinned `xtensa-esp-elf-gdb 17.1` **cannot attach to QEMU's ESP32 gdbstub**: `[RAN]`

```
Remote 'g' packet reply is too long (expected 388 bytes, got 628 bytes)
```

GDB's built-in Xtensa register layout and QEMU's ESP32 core configuration disagree, and
`target remote` dies before a single breakpoint can be set. (The Arduino toolchain ships only the
*unified* `xtensa-esp-elf-gdb`, not a per-target build; ESP-IDF's own QEMU flow uses
`xtensa-esp32-elf-gdb`.) This is worth knowing before anyone plans GDB-based lessons on QEMU.

The ladder sidesteps it: it speaks the GDB remote protocol to QEMU **directly**, using only `Z0`
breakpoints and one register read (PC, register 0 — confirmed by reading `0x40000400`, the ESP32
reset vector, at reset). GDB is still used, but offline, only to turn source lines into addresses.
So the mismatch is a documented gap, not a blocker.

---

## 5. The OLED wall — it is not a wall, and the project's framing was wrong

This is the most consequential correction in this document.

Both the Phase-1 plan and Gate A §5.2 treat `display.begin()` as a hard boot blocker that needs an
emulated SSD1306 ("+5–8 d … needed for unmodified firmware past `bootOrder` step 4"). **It is not.**

`Adafruit_SSD1306::begin()` v2.5.17 returns `false` for exactly one reason: `[SRC]`
`Adafruit_SSD1306.cpp:496-500`

```cpp
bool Adafruit_SSD1306::begin(uint8_t vcs, uint8_t addr, bool reset, bool periphBegin) {
  if ((!buffer) && !(buffer = (uint8_t *)malloc(WIDTH * ((HEIGHT + 7) / 8))))
    return false;
```

It is an **out-of-memory guard, not a device-presence check**. Nothing in `begin()` inspects an
I²C ACK; the init command bytes are pushed onto the bus and their fate ignored. The firmware's own
error string — `"SSD1306 allocation failed."` — says so.

Observed, not just read: `[RAN]`

- **Step 4 REACHED, step 5 REACHED, and the `while (1);` at line 661 was never hit**, in every run.
- QEMU attaches **no SSD1306** to its I²C bus. The only I²C slave the `esp32` machine creates is a
  **TMP105 temperature sensor** (`hw/i2c/esp32_i2c.c`, `esp32_machine_init_i2c`,
  `i2c_slave_create_simple`, `hw/sensor/tmp105.c`). `[SRC]` (symbol table of the shipped binary)

So the OLED costs **zero** emulator work to get past. What it costs instead is *visibility*: with no
SSD1306 model, `display.display()` writes vanish and **nothing renders**. Face state is only
observable through the R6 telemetry hook (`@SESAME face …`), which already works — see §7. The
EXP6 framebuffer hook remains the route to actual pixels.

> **Correction to carry forward:** Gate A §5.2's "ESP32 I²C + SSD1306 device model, +5–8 d, needed
> for unmodified firmware past `bootOrder` step 4" should be re-scoped. It is **not** needed to get
> past step 4 on any emulator. It is only needed to *see the screen*, and the telemetry hook is a
> far cheaper way to do that.

I could not observe the I²C bus directly: QEMU's trace backend is a no-op in this Windows build
(`-trace i2c_*`, `-trace esp32_frc_timer_write` and `-d trace:…` all produce zero events for
known-firing events). `[RAN]` So "does any I²C transaction actually reach the controller model" is
**unanswered**; it does not affect the conclusion, which rests on the source and on the ladder.

---

## 6. The real wall — Wi-Fi, and only Wi-Fi

Stock firmware stops inside step 7. Two distinct failure modes were observed, and across four runs
both appear, sometimes in the same reboot loop: `[RAN]`

**(a) The radio PHY.** `emulator/qemu/logs/ladder-dio.uart.log`

```
assert failed: esp_phy_enable phy_init.c:336 (phy_module_has_clock_bits(PHY_INIT_MODEM_CLOCK_REQUIRED_BITS))
Backtrace: 0x4008bf58 0x4008bf1d 0x400925c9 0x400f5951 0x401231ed 0x4015198d 0x4015236b 0x4014feaa 0x40188419 0x4008cda1
```
resolving to `[RAN]`
```
esp_phy_enable          phy_init.c:336
esp_phy_enable_wrapper  esp_adapter.c:613
wifi_hw_start
wifi_start_process
ieee80211_ioctl_process
ppTask
vPortTaskWrapper
```

The modem clock bits are never set because **QEMU models no ESP32 Wi-Fi MAC or PHY at all** —
a search of the shipped binary's symbol table finds no `esp32_wifi`, no 802.11 and no WLAN device
of any kind, only Windows SDK property-key strings. `[SRC]`

**(b) A cache error during the NVS write inside `esp_wifi_init`.** `emulator/qemu/logs/smoke02-dio.log`

```
Guru Meditation Error: Core  / panic'ed (Cache error).
Cache disabled but cached memory region accessed
```
Core 1's backtrace runs `setup()` → `WiFiGenericClass::mode` → `wifiLowLevelInit` → `esp_wifi_init`
→ `misc_nvs_init` → `nvs_open` → flash write, while Core 0 sits in `esp_cpu_wait_for_intr`. `[RAN]`
This is a QEMU cache/IPC-stall modelling gap around flash writes. `[INFER]`

Failure (b) is plausibly fixable; failure (a) is not, without someone writing an ESP32 Wi-Fi model.
Since **`bootOrder` steps 6–15 are all Wi-Fi, mDNS, DNS and HTTP**, and the servo work is steps
16–19 *behind* them, unmodified Sesame firmware can never reach a moving robot on any emulator that
lacks a radio. Gate A said exactly this; this spike is the second, independent confirmation, on a
completely different emulator.

---

## 7. Wi-Fi elided — the full ladder, and real telemetry

To find out whether anything *past* the radio works, a deliberately modified variant was built.
**This is not stock firmware and must never be described as such.**

`emulator/qemu/make-nowifi-variant.mjs` makes exactly three kinds of change, all anchored by source
text (so it fails loudly rather than editing the wrong line) and all done **by commenting lines out
in place**, so the file's line numbering is preserved and the ladder still lines up with
`hardware-map.json`:

1. 25 lines commented out: Wi-Fi bring-up, SoftAP, mDNS, `dnsServer.start`, `server.begin()`, and
   the three `loop()` calls that service DNS/HTTP.
2. One line injected on an existing blank line: `currentCommand = "wave";` — with no HTTP server
   there is no way to ask the robot to move, and a robot that never moves emits no servo telemetry.
3. The R6 `telemetry-instrumentation.patch` is applied unchanged, from `firmware/patches/`.
   **Nothing in `firmware/` was modified.**

`server.begin()` had to be elided too, and the reason is instructive rather than a QEMU limitation:
it opens an lwIP socket, and lwIP's tcpip thread is started by `WiFi.mode()`. Removing Wi-Fi makes
it assert in `xQueueSemaphoreTake` on a null mutex. `[RAN]` The `server.on(...)` route registrations
(steps 13/14) run fine.

### Result

```
 1  REACHED  line 652-> 832   serial    Serial.begin(115200)
 2  REACHED  line 653-> 833   rng       randomSeed(micros())
 3  REACHED  line 656-> 836   i2c       Wire.begin(I2C_SDA, I2C_SCL)
 4  REACHED  line 659-> 839   display   display.begin(...)
 5  REACHED  line 664-> 844   display   OLED splash
 6  ELIDED   line 674-> 854   wifi
 7  ELIDED   line 677-> 857   wifi
 8  ELIDED   line 688-> 868   wifi
 9  ELIDED   line 689-> 869   wifi
10  ELIDED   line 695-> 875   mdns
11  REACHED  line 703-> 883   state     lastInputTime = millis(); …
12  ELIDED   line 709-> 889   dns
13  REACHED  line 712-> 892   http      server.on() x9
14  REACHED  line 729-> 909   http      server.onNotFound(handleNotFound)
15  ELIDED   line 731-> 911   http      server.begin()
16  REACHED  line 734-> 914   pwm       ESP32PWM::allocateTimer(0..3)
17  REACHED  line 739-> 919   servo     servos[i].setPeriodHertz(50); servos[i].attach(...)
18  REACHED  line 744-> 924   timing    delay(10)
19  REACHED  line 747-> 927   display   setFace("rest")
20  REACHED  line 749-> 929   serial    Serial.println(F("HTTP server & Captive Portal started."))
--  not hit  line 841        display   while(1) after display.begin() returned false

steps whose own code was observed executing: 13 / 13 present  (7 elided from this build)
```
`[RAN]`

Two honesty notes on this table. Steps 13, 14 and 16 resolve to the **same** address because the
compiler emitted no distinct line records for them; the harness labels that rather than hiding it,
and step 16/17's execution is independently proven by the servo output below. And the "ELIDED"
label exists precisely because a commented-out line otherwise borrows its neighbour's address and
would have made the table read a fraudulent 20/20.

### Real telemetry from executing firmware

`emulator/qemu/logs/nowifi-freerun.log`, **55 `@SESAME` lines in a 25-second run** (the count scales
with run length — the idle/blink loop keeps emitting; a 40 s run produced 81): `[RAN]`

```
entry 0x4008059c
@SESAME hello 1 sesame-fw-s2mini/0.1.0
@SESAME face rest 0
HTTP server & Captive Portal started.
WAVE
@SESAME face wave 0
STAND
@SESAME servo R1 135
@SESAME servo R2 45
@SESAME servo L1 45
@SESAME servo L2 135
@SESAME servo R4 0
@SESAME servo R3 180
@SESAME servo L3 0
@SESAME servo L4 180
@SESAME servo R4 80
@SESAME servo L3 180
@SESAME servo L2 90
@SESAME servo R1 100
@SESAME servo L3 180   ← the wave oscillation
@SESAME servo L3 100
…
@SESAME face idle 0
@SESAME face idle_blink 0..3
```

This is `runWavePose()`: the stand prologue, the arm raise, the four-cycle wave on `L3`, the return
to stand, then the idle/blink loop. All eight joints appear. Emitted on **UART0 (`Serial0`)** with
no USB-CDC complication, exactly as R6 designed for this board and as ISSUE-20260823-015 warns is
*not* true of the S2/S3 profiles.

**The servo stream is stable run to run.** Three independent 18-second runs of the freshly rebuilt
image: `[RAN]`

```
run 1: @SESAME=45  servo=29  panics=0
run 2: @SESAME=45  servo=29  panics=0
run 3: @SESAME=57  servo=29  panics=0
```

**Exactly 29 servo events every time** — the whole `runWavePose()` sequence, identical. The total
line count varies only because the idle/blink loop keeps running for however long the capture
lasts. Unlike the stock image's Wi-Fi panic (§6), which varies between two failure modes, nothing
on this path was observed to be flaky. That is the single most encouraging signal for using QEMU in
CI, though it is 3 runs, not a proof.

---

## 8. The bridge — zero changes, confirmed

`emulator/qemu/run-bridge-demo.mjs` runs `emulator/bridge/dist/cli.js` **as built, unmodified**,
against QEMU. Renode published UART0 with `emulation CreateServerSocketTerminal 3456`; QEMU
publishes it with `-serial tcp:127.0.0.1:<port>,server=on,wait=off`. Both are a TCP server carrying
raw bytes, which is the only thing the bridge ever required.

```
[bridge] bridge up: uart tcp://127.0.0.1:57185 -> ws://127.0.0.1:57186/telemetry (default provenance observed)
[bridge] uart connected to 127.0.0.1:57185
[bridge] 1 viewer client connected

=== 53 envelopes over the WebSocket ===
     29  servo.target
     16  face.expression
      7  log
      1  protocol.hello

{"v":1,"n":4,"origin":"uart","event":{"type":"protocol.hello","seq":0,"provenance":"observed","protocolVersion":1,"emitter":"sesame-fw-s2mini/0.1.0"}}
{"v":1,"n":5,"origin":"uart","event":{"type":"face.expression","seq":1,"provenance":"observed","name":"rest","frame":0}}
{"v":1,"n":11,"origin":"uart","event":{"type":"servo.target","seq":7,"provenance":"observed","joint":"R1","angleDeg":135}}
```
`[RAN]`

> **Zero bridge changes were required.** Not one line, not one flag beyond `--uart-port`. The
> architectural claim Path A made with Renode holds on a completely different emulator, with a
> completely different transport implementation, carrying a completely different (and far richer)
> firmware. **Stated plainly, as asked: it did not require changes.**

The one gotcha is a documentation detail, not a code change: the WebSocket path is `/telemetry`,
not `/`.

---

## 9. ESP32-S3 — the machine exists, the firmware does not get in

Because QEMU ships an `esp32s3` machine and that is the **current Distro board**, the S3 profile was
tested too.

- Stock `distro-v3-s3` hits the identical QIO wall. `[RAN]`
- Rebuilt with `FlashMode=dio`, the real S3 ROM (`ESP-ROM:esp32s3-20210327`) runs, the bootloader
  loads all three segments and jumps to the app (`entry 0x403c8898`) — **and then goes silent**. `[RAN]`
- The ladder reports **0 / 20**. `setup()` is never entered. `[RAN]`
- QEMU exposes a single CPU thread (`qfThreadInfo` → `m01`), whose PC is pinned at `0x40036a46`
  across five samples. Resolved against `tools/esp-rom-elfs/esp32s3_rev0_rom.elf`, that is inside
  the mask-ROM routine **`rom_pkdet_vol_start`** (an RF/PHY peak-detector calibration function) —
  nearest-symbol resolution, so treat the exact function as `[SRC]`-quality, the address as `[RAN]`.

So the S3 machine is real but markedly less complete for this workload than the ESP32 machine, and
it also appears to founder on radio-adjacent ROM code. **No further S3 work was attempted** — this
is a spike.

---

## 10. What QEMU actually models

Read out of the shipped binary's symbol table. `[SRC]`

| Present | Notes |
|---|---|
| Real mask ROM (ESP32 v3, S3 rev0, C3) | shipped in `share/qemu/`; R4 had to fetch and slice these by hand for Renode |
| SPI flash controller + flash device | boots the real bootloader; **no Quad-Enable support** (§3) |
| `esp32.dport`, `rtc_cntl`, `timg`, `efuse`, `sha`, `spi`, `apbctrl`, `iomux`, `gpio`, `rtcio` | the register-level SoC that Gate A priced at ≈16–25 d for Renode — **already built** |
| `esp32.ledc` (`hw/misc/esp32_ledc.c`, incl. `esp32_ledc_get_percent`) | the PWM peripheral ESP32Servo drives. Present; **PWM output not independently verified** — the servo evidence in §7 comes from the firmware's own hook |
| `esp32.i2c` (`hw/i2c/esp32_i2c.c`) | controller modelled; only slave attached is a **TMP105** |
| `esp32.twai`, `i2s0/1`, `pcnt`, `rmt`, `slc`, `hinf`, `analog` | present |
| eFuse, Secure Boot v2, virtual framebuffer, GDB stub | per Espressif's ESP-IDF QEMU docs |
| **Absent** | |
| **Wi-Fi MAC / PHY / modem clock** | nothing. This is the wall (§6) |
| **SSD1306** | no OLED slave — costs nothing to boot past (§5), costs visibility |
| **`esp32s2` machine** | the S2 Mini has no platform (§12) |
| **Working trace backend** (this Windows build) | `-trace`/`-d trace:` emit nothing |

---

## 11. Costed recommendation

> **Yes — adopt QEMU as a supported backend, but scope it as an *instrumented-firmware* backend,
> not an unmodified-firmware one. Budget ≈4–7 engineering days for a `QemuSesameRobot`. Do not put
> Phase 1's critical path on it, and do not reopen Renode.**

### Why

1. **The expensive thing is already done.** Gate A priced ≈16–25 d of register-level SoC modelling
   just to reach `setup()` on Renode, and had delivered none of it. QEMU reaches `setup()` today, on
   a stock download, in under half a day of work including the flash-mode diagnosis. The estimate
   for the equivalent QEMU work is **0 d, because it is upstream and maintained by Espressif.**
2. **The wall moved from "everything" to "one subsystem".** Renode's blocker was that no ESP32
   platform exists. QEMU's blocker is Wi-Fi alone — and Gate A already ruled that uncostable and
   already recommended stubbing the API rather than the radio.
3. **The telemetry architecture is now confirmed twice, independently.** §8.

### What a `QemuSesameRobot` would cost

| Item | Est. | Basis |
|---|---:|---|
| Promote the Wi-Fi elision into a real, reviewed `firmware/patches/qemu-nowifi.patch` + a `distro-v1-esp32-qemu` profile in `firmware/build/sketch.yaml`, with F3's pin-assertion machinery | 1 d | the elision already exists and works; this is making it a first-class, provenance-tracked build |
| Replace the injected `currentCommand` line with a **command channel** — the cleanest option is a UART0 reader, since the firmware already has a serial console (`face <name>` at `.ino:818`) | 1–1.5 d | needed for `/api/command` parity; otherwise the backend can only replay one fixed movement |
| `QemuSesameRobot` implementing the `SesameRobot` interface: process lifecycle, port allocation, UART socket, health/restart, teardown | 1.5–2 d | `run-bridge-demo.mjs` is the working spike of this; productionising is lifecycle and error handling |
| Determinism + CI: pin the release, checksum-gate the fetch, make the ladder a test | 0.5–1 d | `fetch-qemu.mjs` and `run-boot-ladder.mjs` already do the work; wiring them into CI is the cost |
| Documentation of the deviations (DIO bootloader, elided Wi-Fi, no OLED render, GDB mismatch) | 0.5 d | honesty tax; these must be visible in the UI's provenance |
| **Total** | **≈4.5–6 d** | plus ~1 d contingency ⇒ **≈4–7 d** |

All `[INFER]`, and uncalibrated in the same way Gate A §4.3 warns about — with one difference in
this spike's favour: **the riskiest item was actually executed**, not estimated. Booting to
`setup()` and getting telemetry out was the unknown, and it came in at about half a day.

### Explicitly *not* recommended

- **Do not** write an ESP32 Wi-Fi model. Not costable, same as Gate A.
- **Do not** write an SSD1306 QEMU device to unblock boot — §5, it is not blocking anything.
- **Do not** reopen Renode for ESP32 SoC work. QEMU delivers the same goal at a fraction of the
  cost and is maintained by the silicon vendor. Gate A's ~3 d of cheap Renode CPU-level upstream
  fixes remain fine to take opportunistically if someone is in that code, but the ≈16–25 d SoC
  track should now be considered **superseded rather than merely parked**.

### Against the behavioural simulator being built right now (V1)

They are not competitors and QEMU must not be allowed to delay V1.

| | `SimulatedSesameRobot` (V1) | `QemuSesameRobot` |
|---|---|---|
| Fidelity | reproduces firmware *semantics* from extracted choreography | runs the *actual compiled firmware* |
| Wi-Fi / HTTP / captive portal | modelled in V5 | **impossible** |
| OLED pixels | exact, V4 | not rendered without the EXP6 hook |
| Determinism | by construction | good, but §6(b) showed run-to-run variation |
| Speed / CI | instant | seconds to boot, a QEMU process per run |
| Teaching value | behaviour, choreography, API | *the real instruction stream* — GDB, real ESP-IDF panics, real backtraces |
| Cost | in progress | ≈4–7 d |

**V1 stays the default backend for every lesson and for `apps/web`.** QEMU earns its place for the
one thing V1 structurally cannot offer: showing a learner that this is real firmware, single-stepped
on a real emulated Xtensa core, with real Espressif panic backtraces. That was listed in Gate A §6
as a trigger that "should reopen the gate" — and QEMU satisfies it for ≈4–7 d instead of ≈16–25 d.

---

## 12. The S2/S3 parity gap — stated honestly

The report recommends the **S2 Mini** for DIY builds and the **S3** for the current Distro board.
QEMU's coverage against that:

| Target | Role | QEMU machine | This spike |
|---|---|---|---|
| ESP32 (LX6), Distro V1 | legacy board, still supported upstream | **`esp32`** | **works: `setup()`, servo path, telemetry** |
| ESP32-S3, Distro V3 | **current** recommended board | `esp32s3` exists | boots ROM + bootloader, **never reaches `setup()`** |
| ESP32-S2, S2 Mini | **recommended DIY board** | **no machine at all** | not testable |

### What a legacy-ESP32-only emulator does buy, educationally

- **Everything above the chip.** The choreography, the 21 movement functions, the `constrain(angle
  + subtrim, 0, 180)` ordering, `motorCurrentDelay`, the `delayWithFace()` re-entrancy point, the
  face state machine and the upstream empty-face bug are **identical across all three boards** —
  they are `.ino` logic, not silicon. The `@SESAME servo` stream in §7 is the same stream the S2
  Mini would produce.
- **A genuine ESP-IDF boot** to point at: real ROM banner, real bootloader, real FreeRTOS, real
  panic backtraces with `addr2line`.
- **A second, independent validation** of the telemetry protocol and bridge (§8).

### What it does not buy

- **Nothing pin-accurate for the recommended boards.** V1 uses `servoPins {15,2,23,19,4,16,17,18}`
  and I²C on 21/22; the S2 Mini uses `{1,2,4,6,8,10,13,14}` with I²C on 33/35 and the S3 uses
  `{4,5,6,7,10,11,12,13}` with I²C on 8/9. A lesson that says "wire the servo to this pin" cannot be
  demonstrated on the ESP32 machine.
- **Nothing about USB-CDC.** The original ESP32 has no USB peripheral, which is exactly why
  telemetry on `Serial0` is uncomplicated here — and exactly why ISSUE-20260823-015 exists for the
  boards that do. QEMU on this target **cannot** exercise that failure mode, so it must not be used
  as evidence that the S2/S3 serial routing works.
- **Nothing about the S2 at all**, and Espressif has shown no sign of adding an `esp32s2` machine.
  Notably, Gate A §6 lists "Espressif publishes a generated S2 LX7 module table" as a Renode
  trigger; the same absence bites here for a different reason.

**Recommended framing for the UI and lessons:** a QEMU backend is *"the real firmware, on the legacy
V1 board"*. It must carry that label in the provenance, not merely `observed`. Per the Phase-1
standing rule, presenting an ESP32-machine run as if it demonstrated S2 or S3 behaviour would be
exactly the kind of papering-over the plan forbids.

---

## 13. Deviations from stock — the complete list

Everything that is not stock Sesame firmware, in one place, so no reader has to reconstruct it.

| # | Deviation | Applies to | Why | Cost to remove |
|---|---|---|---|---|
| 1 | `FlashMode=dio` instead of `qio` | both images | QEMU's flash model has no Quad-Enable bit (§3). Application code is unchanged; only the prebuilt bootloader differs | upstream QEMU fix, or none — it is harmless |
| 2 | Wi-Fi / SoftAP / mDNS / DNS / `server.begin()` commented out | `-nowifi` image only | QEMU has no radio (§6) | none available |
| 3 | `currentCommand = "wave";` injected | `-nowifi` image only | no HTTP server ⇒ no way to command a movement | replaced by a UART command channel, §11 |
| 4 | R6 `telemetry-instrumentation.patch` applied | `-nowifi` image only | to emit `@SESAME`; unmodified from `firmware/patches/` | none — it is the point |
| 5 | Different scratch build path ⇒ different `app_elf_sha256` | all images | F3 §7's known absolute-path embedding | `-ffile-prefix-map`, per F3 |

Nothing under `firmware/`, `hardware/`, `packages/`, `apps/`, `emulator/bridge/` or
`emulator/renode/` was modified by this task.

---

## 14. Reproducing everything

```bash
# 1. Install Espressif QEMU (native Windows, portable, checksum-gated)
node emulator/qemu/fetch-qemu.mjs

# 2. Build the three flash images (needs F3's toolchain: scripts/setup-firmware-toolchain.ps1)
node emulator/qemu/build-qemu-images.mjs all
#   -> emulator/qemu/images/distro-v1-esp32-dio.flash.bin      stock firmware, DIO bootloader
#   -> emulator/qemu/images/distro-v3-s3-dio.flash.bin         stock firmware, DIO bootloader
#   -> emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin   MODIFIED (see section 13)

# 3. Free-run the stock image and watch it die in the radio.
#    snapshot=on keeps the guest's NVS/coredump writes out of the image file - see section 2.
tools/qemu/qemu/bin/qemu-system-xtensa.exe -nographic -machine esp32 \
  -drive file=emulator/qemu/images/distro-v1-esp32-dio.flash.bin,if=mtd,format=raw,snapshot=on

# 4. Walk hardware-map.json's 20-step bootOrder - stock firmware: 7/20
node emulator/qemu/run-boot-ladder.mjs --tag ladder-dio --seconds 45

# 5. Walk it again on the Wi-Fi-elided instrumented build - 13/13 present steps
node emulator/qemu/run-boot-ladder.mjs --tag ladder-nowifi --seconds 40 \
  --image emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin \
  --elf  tools/arduino-data/scratch/qemu-nowifi/out/sesame-firmware-main.ino.elf \
  --remap-from tools/arduino-data/scratch/qemu-dio/sesame-firmware-main/sesame-firmware-main.ino \
  --remap-to   tools/arduino-data/scratch/qemu-nowifi/sesame-firmware-main/sesame-firmware-main.ino

# 6. QEMU -> UART0 over TCP -> the UNMODIFIED Phase-0 bridge -> WebSocket
node emulator/qemu/run-bridge-demo.mjs --seconds 20

# 7. ESP32-S3: boots, never reaches setup()
node emulator/qemu/run-boot-ladder.mjs --tag ladder-s3 --seconds 40 --port 3335 \
  --image emulator/qemu/images/distro-v3-s3-dio.flash.bin \
  --elf  tools/arduino-data/scratch/qemu-s3-dio/out/sesame-firmware-main.ino.elf
```

### Artefacts, and a determinism check

`build-qemu-images.mjs all` was run from scratch after every image had already been built by hand,
and **all three ELFs came back byte-identical**, so the pipeline in §14 is the pipeline that
produced the results in this document. `[RAN]`

| Artefact | SHA-256 |
|---|---|
| `distro-v1-esp32-dio.flash.bin` | `e6db7e8050dc472faf487f4f2d08b6a98ba9915a8a51d6203fb00218286c02d3` |
| ↳ its `.elf` | `95c93a547ade1d3edd359bb761f535a9375687f7cdcdd1efc96ba2def26c2492` |
| `distro-v3-s3-dio.flash.bin` | `db54d88b211e9fae0dd85d9c6eed7696d38fea4dc635ac9217cb09a88360371a` |
| ↳ its `.elf` | `e39dcf63aae0e7a695c9fa54fb58387334dd9c98eaf80ff7a4b451069eeba19f` |
| `distro-v1-esp32-nowifi.flash.bin` | `e6ac171cda45f512b640c24f94e3c7548c5e8e0ea0f17cb2e9056a76428358e6` |
| ↳ its `.elf` | `d2f43c750f8557bfdad211cf6721c4f5d51a0b430266de49157b96dd6c5c933b` |

The `.flash.bin` digests are only stable if every run passes `snapshot=on` (§2). Boot an image
without it and its digest changes, because the guest wrote to it.

`emulator/qemu/images/` and `tools/qemu/` are both gitignored, so these are regeneration checks,
not committed artefacts — the same convention F3 used.

### Scripts

| Path | What |
|---|---|
| `emulator/qemu/fetch-qemu.mjs` | portable, checksum-gated install of the pinned QEMU release |
| `emulator/qemu/build-qemu-images.mjs` | builds all three flash images in gitignored scratch; injects the DIO profiles into the *scratch* `sketch.yaml`, so `firmware/build/sketch.yaml` is untouched and the profile text is still version-controlled |
| `emulator/qemu/make-nowifi-variant.mjs` | the Wi-Fi elision, anchored by source text, line-count preserving |
| `emulator/qemu/run-boot-ladder.mjs` | the 20-step ladder; reads `hardware-map.json`, drives QEMU's GDB remote protocol directly |
| `emulator/qemu/run-bridge-demo.mjs` | QEMU → TCP → unmodified bridge → WebSocket |

### Logs (committed under `emulator/qemu/logs/`)

`smoke01.log` (QIO wall) · `smoke02-dio.log` (cache-error panic) · `stock-rerun-{1,2,3}.log`
(determinism) · `ladder-dio.{uart.log,ladder.json}` (7/20 + PHY assert) ·
`nowifi-freerun.log` + `nowifi-rerun-{1,2,3}.log` (55 `@SESAME` lines; 29 servo events every run) ·
`ladder-nowifi.{uart.log,ladder.json}` ·
`bridge-demo.{qemu,bridge}.log`, `bridge-demo.envelopes.jsonl` · `s3-stock.log`, `s3-dio.log`,
`ladder-s3.ladder.json`

---

## 15. Open items and what this document does not claim

- **It does not claim stock Sesame firmware runs a robot under QEMU.** It reaches `setup()` and
  step 7. Movement required eliding Wi-Fi.
- **It does not claim the emulated PWM is correct.** `esp32.ledc` exists; the servo evidence comes
  from the firmware's own telemetry hook, above the peripheral. Nobody has checked that QEMU's LEDC
  produces the right duty cycle for `attach(pin, 732, 2929)`. **This is the first thing to verify
  if QEMU is adopted**, because it is the difference between "the firmware thinks it moved" and
  "the peripheral was actually driven".
- **It does not claim determinism.** The servo stream was byte-stable across three runs (§7), but
  the *stock* image alternates between two failure modes at step 7 (§6), so the emulator is
  demonstrably timing-sensitive somewhere. Nobody has checked whether `-icount` makes QEMU
  deterministic here; it probably would, and that would matter for CI. `[INFER]`
- **The I²C bus was never observed**, because this build's trace backend is inert (§5).
- **The S3 investigation was one afternoon's worth and stops at a ROM address.** It is a lead, not
  a conclusion.
- **No timing fidelity claim of any kind.** `motorCurrentDelay`, `delayWithFace()` and the 50 Hz
  servo period were not measured against wall-clock or virtual time.
