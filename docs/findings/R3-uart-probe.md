# R3 · Minimal UART probe — compiled C to a typed telemetry event (Experiment 3)

**Task:** R3 (Phase 0, Workstream R) · **Agent:** `renode-platform` · **Date:** 2026-08-23
**Status:** complete · **Result: PASS, end to end.**

**Headline:** A freestanding C program built with the real `xtensa-esp32s2-elf-gcc 14.2.0`,
running on a checked-in ESP32-S2 Renode platform, wrote bytes to UART0 by MMIO. Those bytes
arrived on a host TCP socket, were fed unmodified into the real `@sesame-lab/sesame-protocol`
streaming parser, and came out as
`{ type: 'servo.target', joint: 'R4', angleDeg: 72, provenance: 'observed' }`.

That is the R7 handshake — emulator to typed telemetry — validated four tasks early, with no
mock and no hand-written bytes anywhere in the chain.

---

## 0. Evidence labelling

`[RAN]` verified-by-running · `[SRC]` found-in-source on this machine · `[INFER]` inferred.

---

## 1. What R3 had to add to R1

R1 already moved bytes from the ESP32_UART FIFO register to a host TCP client — but it did that
by poking `sysbus WriteDoubleWord 0x3F400000 <char>` from the Renode monitor. No target code was
involved. R3 closes the loop: the writes now come from **compiled C running on the emulated
core**, and the far end is the **real parser**, not an `echo`.

---

## 2. The platform: `emulator/renode/platforms/esp32s2-sesame.repl`

Checked in, reusable, zero C# written. Renode `1.16.1.19220` from the portable sidecar at
`tools/renode/`. Its SHA-256 is recorded in `reproducibility.json` under `renodePlatformFiles`.

### 2.1 Address provenance — every address, and where it came from

The ESP32-S2 TRM was **not** used as the source. A better one is on this machine: Espressif's own
generated headers and linker scripts, shipped inside the pinned `esp32:esp32 3.3.11` core that F3
installed. They are the same numbers the TRM documents, but they are machine-checkable, they are
version-pinned with the rest of the build, and they cannot be mis-transcribed. All paths below
are relative to
`tools/arduino-data/data/packages/esp32/tools/esp32s2-libs/3.3.11/`. `[SRC]`

| Peripheral / region | Address | Size | Source file : line |
|---|---|---|---|
| Internal SRAM, instruction bus (`iram`) | `0x40020000` | `0x50000` | `include/soc/esp32s2/include/soc/soc.h:164-165` — `SOC_IRAM_LOW 0x40020000`, `SOC_IRAM_HIGH 0x40070000` |
| Internal SRAM, data bus (`dram`) | `0x3FFB0000` | `0x50000` | `soc.h:166-167` — `SOC_DRAM_LOW 0x3FFB0000` (`SOC_DRAM_HIGH` is `0x40000000`; only the first 320 KiB is populated) |
| RTC fast RAM, data view (`rtc_fast_data`) | `0x3FF9E000` | `0x2000` | `soc.h:170-171` — `SOC_RTC_DRAM_LOW/HIGH`; `ld/memory.ld` `rtc_data_seg org = 0x3ff9e000` |
| RTC fast RAM, instruction view (`rtc_fast_instr`) | `0x40070000` | `0x2000` | `soc.h:168-169` — `SOC_RTC_IRAM_LOW/HIGH`; `ld/memory.ld` `rtc_iram_seg org = 0x40070000` |
| RTC slow RAM (`rtc_slow`) | `0x50000000` | `0x2000` | `soc.h:172-173` — `SOC_RTC_DATA_LOW/HIGH`; `ld/memory.ld` `rtc_slow_seg` |
| Flash-mapped rodata (`drom`) | `0x3F000000` | `0x3F0000` | `ld/memory.ld` `drom0_0_seg org = 0x3F000020, len = 0x3f0000-0x20` |
| Flash-mapped code (`irom`) | `0x40080000` | `0x780000` | `ld/memory.ld` `iram0_2_seg org = 0x40080020, len = 0x780000-0x20`; `soc.h:160` `SOC_IROM_LOW 0x40080000` |
| **UART0** | `0x3F400000` | `0x100` | `ld/esp32s2.peripherals.ld:6` — `PROVIDE ( UART0 = 0x3f400000 );` and `include/soc/esp32s2/register/soc/reg_base.h:23` — `DR_REG_UART_BASE 0x3f400000` |
| **UART1** | `0x3F410000` | `0x100` | `esp32s2.peripherals.ld:17`; `reg_base.h:38` — `DR_REG_UART1_BASE 0x3f410000` |

**The one address that is NOT sourced, and is marked as such in the file itself:** the CPU
interrupt number on `uart0`'s IRQ line, written as `IRQ -> cpu@5`. On real silicon UART0 has no
fixed CPU interrupt: the interrupt matrix at `DR_REG_INTERRUPT_BASE = 0x3F4C2000`
(`reg_base.h:8`) maps peripheral source `ETS_UART0_INTR_SOURCE = 37`
(`include/soc/esp32s2/include/soc/interrupts.h:56`) onto whichever free CPU interrupt
`esp_intr_alloc()` picks at run time. **`5` is a placeholder** chosen so the wiring exists and
parses; it is a level-1 CPU interrupt. It is labelled `UNVERIFIED` in the `.repl`. A real
interrupt-matrix model is required before any interrupt-driven path can be trusted.

### 2.2 Simplifications, stated in the file and repeated here

1. **No aliasing.** On silicon the 320 KiB of internal SRAM is visible on both the instruction
   bus (`0x40020000…`) and the data bus (`0x3FFB0000…`). Here they are two independent
   `MappedMemory` regions: a write through one view is *not* visible through the other. Probes
   that keep code and data apart do not care. Anything that writes code through the data bus and
   then executes it — OTA, a JIT, some of IDF's IRAM-attribute setup — will.
2. **No cache, no MMU, no XIP.** `drom` and `irom` are plain RAM standing in for the flash-mapped
   windows. There is no flash controller and no cache MMU, so images must be loaded with
   `LoadELF`; the second-stage bootloader cannot run.
3. **No boot ROM.** The reset vector at `0x40000400` is unbacked and every symbol in
   `esp32s2.rom*.ld` is dangling. R3's script relies on the ELF entry point, which Renode sets
   automatically: `[RAN]` `[INFO] cpu: Setting PC value to 0x4002441C.`
4. **No interrupt matrix.** See §2.1.

### 2.3 It loads clean `[RAN]`

```
  sysbus (SystemBus)
   |- cpu             (Xtensa)
   |- dram            (MappedMemory)  <0x3FFB0000, 0x3FFFFFFF>
   |- drom            (MappedMemory)  <0x3F000000, 0x3F3EFFFF>
   |- iram            (MappedMemory)  <0x40020000, 0x4006FFFF>
   |- irom            (MappedMemory)  <0x40080000, 0x407FFFFF>
   |- rtc_fast_data   (MappedMemory)  <0x3FF9E000, 0x3FF9FFFF>
   |- rtc_fast_instr  (MappedMemory)  <0x40070000, 0x40071FFF>
   |- rtc_slow        (MappedMemory)  <0x50000000, 0x50001FFF>
   |- uart0           (ESP32_UART)    <0x3F400000, 0x3F4000FF>
   \- uart1           (ESP32_UART)    <0x3F410000, 0x3F4100FF>
```

No `Python.PythonPeripheral` stubs are present, because nothing the R2/R3 probes touch needs one:
they access memory and UART0 and nothing else. Adding stubs that silently return zero would make
the platform *less* honest, not more. R4 will need them; that is R4's call to make against the
real ELF's actual accesses.

---

## 3. The firmware: `firmware/probes/r3/uart_hello.c`

Freestanding C. No ESP-IDF, no Arduino, no libc. Built by the same
`bash firmware/probes/build-probes.sh` as the R2 ladder, sharing R2's `start.S`, `vectors.S` and
linker script, so it runs with the windowed ABI and a working exception vector table.

```c
#define UART0_BASE   0x3F400000u                                  /* esp32s2.peripherals.ld:6 */
#define UART_FIFO    (*(volatile uint32_t *)(UART0_BASE + 0x00u))  /* uart_reg.h:14   */
#define UART_INT_ENA (*(volatile uint32_t *)(UART0_BASE + 0x0Cu))  /* uart_reg.h:266  */
#define UART_INT_CLR (*(volatile uint32_t *)(UART0_BASE + 0x10u))  /* uart_reg.h:388  */
#define UART_STATUS  (*(volatile uint32_t *)(UART0_BASE + 0x1Cu))  /* uart_reg.h:538  */
#define TXFIFO_CNT(s) (((s) >> 16) & 0x3FFu)   /* UART_TXFIFO_CNT_S 16, _V 0x3FF: uart_reg.h:561-562 */
```

All offsets and the `TXFIFO_CNT` field position come from
`include/soc/esp32s2/register/soc/uart_reg.h`. `[SRC]`

`uart_putc()` polls `TXFIFO_CNT` with a bounded retry (so a model that never drains the FIFO
cannot hang the probe) and then writes the byte to `UART_FIFO`. It is deliberately **polled, not
interrupt-driven**, because R1 §8.2 established that Renode's `ESP32_UART` never implements
`UART_INT_ST` — §4 below confirms that at run time.

The seven lines it emits, byte for byte:

```
r3-uart-probe: esp32s2 uart0 mmio, no idf\r\n
@SESAME hello 1 sesame-lab-r3\n
@SESAME servo R4 72\n
@SESAME servo L1 15\n
@SESAME face wave 0\n
@SESAME log firmware renode esp32s2 uart0 up\n
r3-uart-probe: done\r\n
```

The mix is intentional: plain boot chatter with CRLF, `@SESAME` frames with LF, and the exact
`@SESAME servo R4 72` line the task named.

---

## 4. What the ESP32_UART model actually does, measured `[RAN]`

Running the probe at `logLevel 0` and then reading the register window back:

| Access | Result |
|---|---|
| write `UART_INT_ENA` (0x0C) `= 0` | accepted |
| write `UART_INT_CLR` (0x10) `= 0xFFFFFFFF` | `[WARNING] uart0: Unhandled write to offset 0x10. Unhandled bits: [20-31] ... Tags: RESERVED (0xFFF).` — accepted, upper bits ignored |
| read `UART_STATUS` (0x1C) | `0xE000C000` → `TXFIFO_CNT = 0`, `RXFIFO_CNT = 0`. The poll loop therefore exits immediately; the probe recorded **0 poll spins** |
| read `UART_INT_ST` (0x08) | `[WARNING] uart0: Unhandled read from offset 0x8.` → returns 0. **Confirms R1 §8.2 at run time** |
| read `UART_DATE` (0x74) | `[WARNING] uart0: Unhandled read from offset 0x74.` → returns 0 |
| read offset `0x78` | returns `0x00000000` with **no** warning |

**New finding, extending R1 §6 row 6.** R1 observed that Renode's `ESP32_UART` has
`CLK_CONF @ 0x78`, `Version @ 0x7C`, `ID @ 0x80` and concluded that was "the S2/S3/C3 layout".
The S2 half of that is wrong. Per `uart_reg.h`, the **ESP32-S2 has no `CLK_CONF` register at
all**; on the S2, `0x74` is `UART_DATE` (`uart_reg.h:1080`) and `0x78` is `UART_ID`
(`uart_reg.h:1088`). So Renode's model decodes `0x78` as `CLK_CONF` while S2 firmware reading the
same address expects `UART_ID`. Any driver that probes `UART_ID` gets `0` instead of the chip's
value. The model is S3/C3-shaped, not S2-shaped. `[SRC]` + `[RAN]`

Practical consequence: **TX by polled FIFO writes works perfectly; anything that probes IDs,
configures clocks, or uses interrupts does not.** That is exactly enough for the Sesame telemetry
line protocol, and not enough for the stock Arduino `HardwareSerial` driver. R4 will hit it.

Also confirmed at run time: the probe recorded **zero CPU exceptions** across all its MMIO
accesses, so `memw`-guarded volatile access to a peripheral window behaves correctly.

---

## 5. End to end `[RAN]`

### 5.1 The sequencing problem, and how it is solved

Renode's server socket terminal has **no backlog**: bytes the target writes before a client
attaches are dropped on the floor. So `emulator/renode/scripts/r3-uart-hello.resc` deliberately
does *not* start the machine. It loads the platform and the ELF, opens the socket, prints a
`### R3-READY` banner, and leaves the monitor open on stdin. The harness then connects its client
and only afterwards types `emulation RunFor` at the monitor.

The socket incantation, exactly as R1 §5.4 established:

```
emulation CreateServerSocketTerminal 3456 "uartsock" false
connector Connect uart0 uartsock
```

`telnetMode = false` is load-bearing: the default `true` splices telnet IAC negotiation bytes into
the stream and would corrupt the `@SESAME` framing.

### 5.2 Run it

```
bash firmware/probes/build-probes.sh                 # once, to build the ELF
node emulator/renode/tests/r3-uart-capture.mjs       # spawns Renode, captures, parses, asserts
```

Exit code 0 means every assertion held. The committed run output is
`emulator/renode/tests/logs/r3-uart-capture.txt`.

By hand, if you want to watch it: run the `.resc` yourself, connect any TCP client to
`127.0.0.1:3456`, then type `emulation RunFor "0.02"` at the Renode monitor.

### 5.3 Bytes actually received on the socket

199 bytes, verbatim:

```
r3-uart-probe: esp32s2 uart0 mmio, no idf\r\n@SESAME hello 1 sesame-lab-r3\n@SESAME servo R4 72\n@SESAME servo L1 15\n@SESAME face wave 0\n@SESAME log firmware renode esp32s2 uart0 up\nr3-uart-probe: done\r\n
```

Byte-identical to the `.rodata` string table in the ELF. No `0xFF` anywhere, i.e. `telnetMode`
really was off.

### 5.4 Those bytes through the real parser

`emulator/renode/tests/r3-uart-capture.mjs` imports
`packages/sesame-protocol/dist/index.js` — the actual built R5 package, by relative path (the
`emulator/renode` directory is not a pnpm workspace package and this test deliberately does not
require it to become one) — and feeds it the received `Buffer` with no preprocessing:

```json
{"type":"log","seq":0,"provenance":"observed","channel":"uart","text":"r3-uart-probe: esp32s2 uart0 mmio, no idf"}
{"type":"protocol.hello","seq":1,"provenance":"observed","protocolVersion":1,"emitter":"sesame-lab-r3"}
{"type":"servo.target","seq":2,"provenance":"observed","joint":"R4","angleDeg":72}
{"type":"servo.target","seq":3,"provenance":"observed","joint":"L1","angleDeg":15}
{"type":"face.expression","seq":4,"provenance":"observed","name":"wave","frame":0}
{"type":"log","seq":5,"provenance":"observed","channel":"firmware","text":"renode esp32s2 uart0 up"}
{"type":"log","seq":6,"provenance":"observed","channel":"uart","text":"r3-uart-probe: done"}
```

Assertions, all passing:

```
PASS  UART0 produced bytes on the host TCP socket  -- 199 bytes
PASS  no telnet IAC (0xFF) bytes in the stream  -- telnetMode=false held
PASS  real parser produced servo.target { joint: R4, angleDeg: 72 }
PASS  that event is tagged provenance=observed
PASS  second servo.target { joint: L1, angleDeg: 15 } parsed
PASS  face.expression parsed
PASS  non-@SESAME boot chatter surfaced as log events  -- 3 log events
PASS  no protocol.unknown events

R3: ALL CHECKS PASSED
```

**This is the R7 contract, proven with a real emulator on one end and the real protocol package
on the other.** Path A in the plan's R7 ("Renode → emulated UART socket → bridge → WebSocket →
viewer") now has its hardest link demonstrated; only the bridge and the viewer remain, and both
are host-side TypeScript.

### 5.5 One thing R3 got wrong the first time, worth recording

The probe's first draft emitted `@SESAME log info renode esp32s2 uart0 up`. The parser rejected
it as `protocol.unknown / bad-channel`: the valid `LogChannel` set is `uart | firmware | emulator`
and `info` is not a channel. The firmware line was corrected, not the parser. This is exactly the
class of drift the R7 contract test exists to catch, and it caught it on day one. `[RAN]`

---

## 6. Artifacts

| Path | What |
|---|---|
| `emulator/renode/platforms/esp32s2-sesame.repl` | the ESP32-S2 platform, with per-address provenance in comments |
| `firmware/probes/r3/uart_hello.c` | the freestanding UART writer |
| `emulator/renode/scripts/r3-uart-hello.resc` | loads the platform + ELF, opens tcp/3456, pauses |
| `emulator/renode/tests/r3-uart-capture.mjs` | the end-to-end harness and its assertions |
| `emulator/renode/tests/logs/r3-uart-capture.txt` | committed output of the run quoted above |
| `firmware/probes/build-probes.sh` | builds this ELF alongside the R2 ladder |

`r3-uart-hello.elf`: 12 456 bytes, reproducible `--strip-all` image SHA-256
`798985f15a29a2b5ed25823ce59f27afe51169237af9d8c6ef926e7395279793`. (See R2 §7 for why the full
ELF hash moves by six bytes across rebuilds.)

---

## 7. What R4 and R7 should take from this

1. **The bridge primitive is real and typed.** `emulator/bridge/` can be written against a live
   Renode socket today, not just a replay file.
2. **Use polled TX only.** Until `UART_INT_ST` (0x08) is implemented, nothing interrupt-driven on
   UART0 will work. That is a ~3-line upstream fix to `ESP32_UART.cs` and a good contribution
   back (R1 §8.2).
3. **`ESP32_UART` is S3/C3-shaped, not S2-shaped** (§4). If R4 sees a driver stall reading
   `UART_ID` or a clock register, that is why. Consider mapping `uart0` for the S3 profile first,
   where the model's layout is closer to correct.
4. **The `IRQ -> cpu@5` line in the `.repl` is a placeholder**, not a fact. An interrupt-matrix
   model is required before it means anything.
5. **The no-aliasing simplification is the one most likely to bite R4.** If the real ELF writes
   IRAM through the data bus during startup and then executes it, the platform needs the two
   windows backed by one memory. Renode can do that; it just is not done here because the R2/R3
   probes proved they do not need it and a wrong alias would have been worse than none.
