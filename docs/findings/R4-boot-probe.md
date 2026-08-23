# R4 · Arduino startup + Sesame boot probe (Experiments 4 & 5)

**Task:** R4 (Phase 0, Workstream R) · **Agent:** `renode-boot` · **Date:** 2026-08-23
**Status:** complete
**Result: a precise negative, as planned — plus one blocker that turned out to be solvable today.**

**Headline:** On the checked-in ESP32-S2 platform, both the minimal Arduino sketch and the real
Sesame firmware fail on **their very first instruction** — `entry a1, N` at the ELF entry point —
because there is no boot ROM to establish `PS.WOE` and a stack pointer. **0 of the 20 `bootOrder`
steps are reached; `setup()` is never entered.** Behind that sit, in order: no ROM image (126
symbols, 1209 call sites), the EXTMEM cache controller, the SPI-flash controller, and only *then*
the CPU-level `salt`/`saltu` gap R2 predicted. R4 obtained and loaded Espressif's official
ESP32-S2 mask-ROM image, which retires blocker #2 outright, and drove the boot far enough to
observe the **first `saltu` on the real firmware's real boot path** at PC `0x400E6AD2` in
`s_get_bus_mask`, and the **`rer` hard abort** at PC `0x4009BAC2` in `panic_handler`.

> **Gate A above the CPU line: NO — but bounded, ordered and priced.** See §8.

---

## 0. Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | **verified-by-running** on this machine. Every quoted log line is real, captured output |
| `[SRC]` | **found-in-source** — read out of a file on this machine, or out of an upstream repository over the GitHub API |
| `[INFER]` | **inferred**. Reasoned, not observed |

Runs whose machine includes the RAM-backed MMIO shim are additionally marked
**`[DIAG]` — non-authoritative**. Nothing in a `[DIAG]` run is evidence about ESP32-S2 behaviour;
those runs exist only to enumerate blockers in order.

---

## 1. What R4 built

| Path | What | Notes |
|---|---|---|
| `firmware/probes/r4/r4-arduino-min/r4-arduino-min.ino` | the Experiment-4 sketch | `setup()` prints a marker, `loop()` empty, plus raw UART0 FIFO markers |
| `firmware/probes/build-r4-arduino.mjs` | builds it with **F3's own profile machinery** | same `tools/arduino-cli`, same `firmware/build/sketch.yaml`, same `ARDUINO_DIRECTORIES_*` / `SOURCE_DATE_EPOCH` env copied verbatim from `scripts/build-firmware.mjs`. The only difference from an F3 build is which `.ino` is compiled |
| `scripts/fetch-esp32s2-rom.mjs` | fetches + checksum-verifies + slices Espressif's ESP32-S2 mask ROM | output under `tools/esp-rom-elfs/` (gitignored, nothing machine-wide) |
| `emulator/renode/platforms/esp32s2-rom.repl` | ROM address windows, overlay on `esp32s2-sesame.repl` | real image, not a stub |
| `emulator/renode/platforms/esp32s2-mmio-shim.repl` | **`[DIAG]`** RAM-backed stand-in for the whole peripheral window | labelled non-authoritative in the file itself |
| `emulator/renode/scripts/r4-bootstate.resc` | stands in for the processor state the ROM would have left | PS / window state / SP trampoline |
| `emulator/renode/scripts/r4-shim-seeds.resc` | **`[DIAG]`** the specific status bits boot code busy-waits on | growing this file *is* the blocker enumeration |
| `emulator/renode/scripts/r4-exp{4,5}-*.resc` | one re-runnable script per rung | see §11 |
| `emulator/renode/tests/r4-run.mjs` | timeout-guarded Renode runner | streams to a log, kills the process tree with `taskkill /T /F` — because `rer` really does wedge the emulator (§4.6) |
| `emulator/renode/tests/logs/r4-*.log` | committed raw evidence for every run quoted below | |

Nothing under `reference/`, `firmware/upstream/`, `packages/`, `emulator/bridge/`,
`debug-viewer/` or `C:\Program Files\Renode` was touched. No Renode source was built and no tlib
was patched — §7 is an *assessment* only.

### 1.1 Artifact identities `[RAN]`

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `r4-arduino-min.elf` (full) | 6 782 092 | `3df6d7c6b37731d313ac6a3d900bc981841f165c8bf21db41bdea490fa18968e` |
| `r4-arduino-min.elf` (`--strip-all` image, reproducible) | 356 900 | `197f3a217790f25b22bd2c9c2b1b1ac689ab83978d420e19cbbc63169a35b82b` |
| `r4-arduino-min.bin` | 289 840 | `2a375c07402a71a74165fbce0110604f778de2a6007e7265d6dfbd447f868a2e` |
| `esp-rom-elfs-20260528.tar.gz` | 4 902 355 | `caa463d3cbef2430a5a35847c1d9f2f152403b17a802050927ff60c8da54fe46` (matches Espressif's published checksum file) |
| `esp32s2_rev0_rom.elf` | 292 128 | `cabae5c901fe816aea5e74fbb621ad6479ad1b399d6e7212295191559654572d` |
| `rom-code.bin` → `0x40000000` | 114 384 | `70f76bfd186408d585e5ba1fe83073b1dd3dfa9be418d1b2900f34dbf1c4d3d6` |
| `rom-rodata.bin` → `0x3FFAC600` | 14 636 | `4c7dfbbad125c012c8ba76549d8271a54924f44c12ef8cc3b8825213b669c99f` |
| `rom-data.bin` → `0x3FFFEB70` | 5 160 | `50e86ebf96f01a9a954d963dc104ad4520375473be205e43c428f3a6fb161b8c` |
| `esp32s2-rom.repl` | — | `66e12911481271a37182f33971d6c33b2ca5b90663c717e128aca5e893f70350` |
| `esp32s2-mmio-shim.repl` | — | `e7c601519fc580ed14fb5eac460b22f83a63f70b04fd562e18f18cb388746067` |

`r4-arduino-min.elf` entry point **`0x40025504`** (`call_start_cpu0`); the real Sesame S2 ELF's is
**`0x40025738`**, exactly as F3 §1 recorded. `[RAN]` `readelf -h`

---

## 2. Experiment 4 — does the Arduino-ESP32 runtime reach user `setup()`?

### 2.1 Verdict

> **NO.** It does not execute a single instruction of its own entry function.
> `[RAN]` `emulator/renode/tests/logs/r4-exp4-arduino.log`

```
[INFO]  cpu: Setting PC value to 0x40025504.
### entry PC
0x40025504
[INFO]  r4-arduino: Machine started.
[ERROR] cpu: Illegal entry instruction(pc = 40025504)
[WARNING] sysbus: [cpu: 0x400003C0] ReadByte from non existing peripheral at 0x400003C0.
[ERROR] cpu: CPU abort [PC=0x400003C0]: Trying to execute code outside RAM or ROM at 0x400003C0.
```

The instruction at `0x40025504` is `entry a1, 48` — the first instruction of `call_start_cpu0`.
`[SRC]` `xtensa-esp32s2-elf-objdump -d`

Renode is behaving correctly. Measured processor state immediately after `LoadELF`, before the
machine starts: `[RAN]` `logs/r4-resetstate.log`

```
PS 0x0000001F   (WOE=0, EXCM=1, INTLEVEL=15)     VECBASE 0x40000000
WINDOWBASE 0    WINDOWSTART 0                    AR1 (SP) 0x00000000
```

That is the architectural Xtensa reset state. tlib's `helper_entry` raises
`ILLEGAL_INSTRUCTION_CAUSE` unless `(PS & (WOE|EXCM)) == WOE`, so `entry` faults; the fault vectors
through `VECBASE = 0x40000000`, which is the **boot ROM**, which does not exist in the platform —
hence the second error, at the ROM's `DoubleExceptionVector` address `0x400003C0`.

**This is a boot-ROM problem wearing a CPU costume.** On silicon the mask ROM sets `PS`, `SP` and
`VECBASE` long before the application entry point runs. `esp32s2-sesame.repl` note 3 already said
"NO BOOT ROM"; R4's contribution is showing that this alone stops execution at instruction #0,
before anything else can even be measured.

### 2.2 The escalation ladder, and where each rung stops

Each rung adds exactly one thing. Rungs A–C are authoritative; rung D is `[DIAG]`.

| Rung | Machine | Stops at | Symbol / cause |
|---|---|---|---|
| **A** | stock `esp32s2-sesame.repl` | PC `0x40025504`, **instruction #0** | `entry` illegal — `PS.WOE=0`, no boot ROM to set it |
| **B** | + `r4-bootstate.resc` | PC `0x4000FF58`, **5 instructions in** | `callx8` to ROM `esp_rom_get_reset_reason` — no ROM image |
| **C** | + real ESP32-S2 mask ROM | PC `0x400184BE`, spinning | ROM `Cache_Suspend_ICache_Autoload` polls `EXTMEM 0x61800040` bit 19 forever |
| **D** `[DIAG]` | + RAM-backed MMIO + seeds | PC `0x40025185`, spinning | `bootloader_flash_execute_command_common` (`bootloader_flash.c:845`) polls the SPI1 command register forever |

Rung A `[RAN]` `logs/r4-exp4-arduino.log` · rung B `[RAN]` `logs/r4-exp4-arduino-bootstate.log` ·
rung C `[RAN]` `logs/r4-exp4-arduino-rom.log` · rung D `[RAN]` `logs/r4-exp4-arduino-shim.log`.

Rung B's log, the whole interesting part: `[RAN]`

```
### bootstate applied - PS / WINDOWSTART / SP trampoline at 0x4006FF00
0x50020
0x4006ff00:   11feff 	l32r	a1, . -8
0x4006ff03:   81feff 	l32r	a8, . -8
0x4006ff06:   a00800 	jx	a8
[INFO]  r4-arduino-b: Machine started.
[WARNING] sysbus: [cpu: 0x4000FF58] ReadByte from non existing peripheral at 0x4000FF58.
[ERROR] cpu: CPU abort [PC=0x4000FF58]: Trying to execute code outside RAM or ROM at 0x4000FF58.
```

`call_start_cpu0`'s fifth instruction is `callx8` to `0x4000FF58 = esp_rom_get_reset_reason`. `[SRC]`

**Note on `r4-bootstate.resc`:** `PS`, `WINDOWBASE` and `WINDOWSTART` are settable from the Renode
monitor, but the Xtensa **address registers are not** — `cpu SetRegister 2` and
`cpu SetRegister "AR1"` both silently no-op and `GetRegister` always reads `0x0`
(`[RAN]` `logs/r4-setreg.log`). The stack pointer is therefore installed by a hand-assembled
three-instruction trampoline in unused IRAM, whose encoding was verified with
`cpu DisassembleBlock` (`[RAN]` `logs/r4-asm.log`). SP value `0x3FFFE70C` is `SOC_ROM_STACK_START`
from `esp32s2-libs/3.3.11/include/soc/esp32s2/include/soc/soc.h:207` — literally the stack pointer
the ROM hands over. `[SRC]`

### 2.3 The marker never fires

`r4-arduino-min.ino` emits raw UART0 FIFO markers `@R4A` (first instruction of `setup()`), `@R4B`
(after `Serial.begin`), `@R4C` (after `Serial.println`), `@R4L` (first `loop()`). **None of the four
ever reached the socket in any rung.** `[RAN]`

The markers are raw MMIO stores rather than `Serial` calls on purpose, and that turned out to matter
for a second reason — see §6.4: on the `s2mini` profile `Serial` is **not** UART0.

---

## 3. The boot-ROM blocker, and how R4 retired it

`call_start_cpu0` is five instructions from a ROM call, and it is not an outlier. Counted over the
real Sesame S2 ELF's full disassembly: `[RAN]`

> **126 distinct symbols in the ROM window `0x40000000–0x4001FFFF`, referenced 1209 times.**

| Refs | Category | Examples |
|---:|---|---|
| 506 | `mem*` / `str*` | `memcpy` (194), `memset` (147), `strlen` (47), `strcmp` (41), `memmove`, `memcmp` |
| 446 | libgcc soft-float / newlib helpers | `__muldf3` (89), `__subdf3` (52), `__adddf3` (40), `__lshrdi3`, `__udivdi3`, `_fflush_r` |
| 142 | `esp_rom_*` API | `esp_rom_printf` (47), `esp_rom_delay_us` (34), `esp_rom_gpio_connect_in_signal` (15), `esp_rom_route_intr_matrix` (6) |
| 55 | other | `crc32_le`, `gpio_matrix_out`, `qsort`, `bzero`, `_heap_end` |
| 25 | cache / MMU | `Cache_Suspend_ICache`, `Cache_Invalidate_DCache_All`, `Cache_Allocate_SRAM` |
| 17 | `ets_` / `rtc_` / PHY | `phy_get_romfuncs`, `ets_install_putc1` |
| 16 | xtos runtime | `_xtos_set_intlevel` |
| 2 | SPI flash | `SelectSpiQIO` |

F3 §1 flagged exactly this and was right: *"If Renode has no ROM image, every one of those addresses
is an unbacked read — likely the first thing R2/R4 trips over."*

### 3.1 It is a download, not a research project

Espressif publishes the ROM as an ELF **with code and symbols** — the same artifact OpenOCD and GDB
use for ROM backtraces — at `github.com/espressif/esp-rom-elfs`. `scripts/fetch-esp32s2-rom.mjs`
fetches release `20260528`, verifies the tarball against Espressif's published SHA-256, and slices
`esp32s2_rev0_rom.elf` into three flat images. `[RAN]`

| Image | Load address | Bytes | Contents |
|---|---|---:|---|
| `rom-code.bin` | `0x40000000` | 114 384 | all `AX` sections: `.WindowVectors.text` … `.ResetVector.text`, `.bt_text`, `.text` (ends `0x4001BED0`) |
| `rom-rodata.bin` | `0x3FFAC600` | 14 636 | `.rodata` (ends `0x3FFAFF2C`) |
| `rom-data.bin` | `0x3FFFEB70` | 5 160 | the non-empty `.data_*` sections (`.data_xtos`, `.data_usbdev`, `.data_spi_flash`, `.data_phyrom`, …) |

Sliced by section rather than `LoadELF`'d because the ROM ELF carries a program header with
`p_offset 0 / p_filesz 0x434` over a NOBITS range — loading it verbatim would splatter the ELF
header into the ROM's shared-buffer area at `0x3FFEA6D0`. `[SRC]` `readelf -l`
(Two other gotchas, both recorded in the fetch script so they are not rediscovered: the `.data_*`
sections carry `SHF_WRITE` but **not** `SHF_ALLOC`, so `objcopy -O binary` silently drops them
unless `--set-section-flags …=alloc,load,contents` is passed; and grouping `.static_dram_start`
with them would gap-fill 80 KiB of zeros across the ROM's BSS.)

`esp32s2-rom.repl` adds the two windows the image needs. `0x40000000–0x4001FFFF` is
`SOC_IROM_MASK_LOW/HIGH` (`soc.h:162-163`); the ROM's rodata at `0x3FFAC600` sits **below**
`SOC_DRAM_LOW = 0x3FFB0000` (`soc.h:166`) and is not covered by the base platform's `dram`, so it
gets its own `rom_data` region. `[SRC]`

**Result: the ROM executes.** Rung C's log shows real ROM code running — `rtc_get_reset_reason`
reading `RTCCNTL 0x3F408038`, `Cache_Resume_ICache`, `Cache_Allocate_SRAM` writing
`SENSITIVE 0x3F4C107C` — before the cache busy-wait stops it. `[RAN]`

**Cost of this blocker, revised: from "unknown, needs a ROM we do not have" to ~0.25 engineering
days.** That is the single largest estimate change R4 produces.

---

## 4. Experiment 5 — the real Sesame ELF against F4's `bootOrder`

Subject: `firmware/artifacts/s2mini/sesame-firmware-main.ino.elf`, F3's `s2mini` profile,
entry `0x40025738`.

### 4.1 Rung A — authoritative, stock platform `[RAN]` `logs/r4-exp5-sesame-stock.log`

```
[INFO]  cpu: Setting PC value to 0x40025738.
### entry PC
0x40025738
[INFO]  r4-sesame-a: Machine started.
[ERROR] cpu: Illegal entry instruction(pc = 40025738)
[WARNING] sysbus: [cpu: 0x400003C0] ReadByte from non existing peripheral at 0x400003C0.
[ERROR] cpu: CPU abort [PC=0x400003C0]: Trying to execute code outside RAM or ROM at 0x400003C0.
```

Byte-for-byte the same failure as the minimal sketch. The real firmware and the three-line sketch
are indistinguishable at this point, which is itself informative: **nothing about Sesame is the
problem.**

### 4.2 The ladder, and how far each rung got

| Rung | Machine | Instructions retired | Stopped at | Cause |
|---|---|---:|---|---|
| **A** | stock | 0 | `0x40025738` | `entry` illegal (`PS.WOE=0`) |
| **B** | + boot state | 5 | `0x4000FF58` | ROM `esp_rom_get_reset_reason` — no ROM |
| **C** | + real ROM | 5 000 000 (all spinning) | `0x400184BE` | ROM `Cache_Suspend_ICache_Autoload`, `EXTMEM 0x61800040` bit 19 never sets |
| **D** `[DIAG]` | + full RAM MMIO shim + seeds | 20 000 000 (all spinning) | `0x400253BE` | `bootloader_flash_execute_command_common`, SPI1 command bit never clears |
| **E** `[DIAG]` | + real ROM, **EXTMEM window only** | n/a — aborted mid-run | `0x400E6AD2` → panic → **emulator abort** | **`saltu a2, a10, a8` illegal**, then `rer` in `panic_handler` kills Renode |

Rung E never printed a final PC: `emulation RunFor` never returned after the `rer` abort and
`r4-run.mjs` had to kill the process tree (`### R4-RUNNER: ... (KILLED ON TIMEOUT)` at the end of
`logs/r4-exp5-sesame-observe.log`). That is R2 §3.6's failure mode, reproduced by the real
firmware's own boot rather than by a synthetic probe.

Rung E is the one that goes furthest, and the reason is a methodology lesson worth keeping: with the
SPI window left **unmapped**, reads return 0 and the `bnez` poll in
`bootloader_flash_execute_command_common` exits immediately, whereas the RAM-backed shim faithfully
returns the `SPI_MEM_USR` bit the code just set and spins forever. **A less complete machine walked
further than a more complete one.** Neither is right; both are `[DIAG]`.

### 4.3 The boot ladder actually walked — rung E, symbol by symbol

From `cpu LogFunctionNames true true`, in execution order.
`[RAN]` `logs/r4-exp5-sesame-observe.log`

```
call_start_cpu0
  rtc_get_reset_reason  memset                                                   [ROM]
  cache_hal_init  s_cache_hal_init_ctx
    Cache_Enable_ICache  Cache_Resume_ICache  Cache_Resume_ICache_Autoload       [ROM]
    Cache_Enable_DCache  Cache_Resume_DCache  Cache_Resume_DCache_Autoload       [ROM]
  esp_config_instruction_cache_mode
    Cache_Allocate_SRAM  Cache_Suspend_ICache  Cache_Suspend_ICache_Autoload     [ROM]
    Cache_Set_ICache_Mode  Cache_Invalidate_ICache_All  Cache_Invalidate_ICache_Items
  esp_config_data_cache_mode
    Cache_Set_DCache_Mode  Cache_Invalidate_DCache_All  Cache_Invalidate_DCache_Items
  sys_rtc_init  esp_rtc_init  rtc_init  rtc_sleep_pd  sar_periph_ctrl_init
  mspi_init  esp_mspi_pin_init
    bootloader_flash_update_id  bootloader_read_flash_id
    bootloader_execute_flash_command  bootloader_flash_execute_command_common
    flash_init_state  spi_flash_init_chip_state  mspi_timing_flash_tuning
  esp_mmu_map_init
    s_get_bus_mask                       <-- unrecognized opcode in slot 0 (pc = 400e6ad2)
  _UserExceptionVector  _xt_user_exc  _xt_handle_exc  _xt_context_save
    xthal_save_extra_nw  _WindowOverflow4  _WindowOverflow8
  xt_unhandled_exception  panic_enable_cache  spi_flash_cache_enabled
  panic_handler                          <-- CPU abort: reading from external register not supported
```

**34 functions. All of them inside `call_start_cpu0`'s prologue.** Execution never reaches
`system_early_init`, never reaches `g_startup_fn` / `start_cpu0`, never starts FreeRTOS, never
reaches `app_main`, `loopTask` or `setup()`.

Incidentally, this is also positive evidence for R2: thousands of ROM instructions, the complete
window overflow/underflow machinery inside `_xt_context_save`, and `l32r` literal pools across three
address windows all executed correctly on the way here.

### 4.4 Position on F4's `bootOrder`

> **0 of 20 steps reached, in every configuration tried, authoritative or diagnostic.**

| `bootOrder` step | Reached? |
|---|---|
| 1 `Serial.begin(115200)` (`.ino:652`) … 20 `Serial.println("HTTP server & Captive Portal started.")` (`.ino:749`) | **none** |

The ladder in the plan's R4 description — *serial init → `Wire.begin` → `display.begin()` → Wi-Fi →
server → servo attach* — is not the ladder that matters. The real ladder is **below** it, in the
ESP-IDF startup that Arduino sits on top of, and that is where all of the cost is. F4's
`display.begin()` hard-fail at `.ino:662` remains a genuine future blocker for unmodified firmware,
but it is nowhere near the binding constraint today.

### 4.5 The exact first CPU-level blocker on the real boot path `[RAN]` + `[SRC]`

```
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 400e6ad2)
```

| Field | Value |
|---|---|
| **PC** | `0x400E6AD2` |
| **Instruction** | `saltu a2, a10, a8` — 24-bit encoding `0x622A80` (op0=0, op1=6, op2=2, r=a2, s=a10, t=a8), the same field layout as the `saltu a6, a7, a7` = `0x626770` R2 captured in `firmware/probes/build/r2-rung5-mem.dis` |
| **Symbol** | `s_get_bus_mask` (`0x400E6ABC`), reached from `esp_mmu_map_init` |
| **Source line** | inlined `cache_ll_l1_get_bus`, `esp-idf/components/hal/esp32s2/include/hal/cache_ll.h:473` (`xtensa-esp32s2-elf-addr2line`) |
| **Consequence** | `ILLEGAL_INSTRUCTION` → `_UserExceptionVector` → `xt_unhandled_exception` → `panic_handler` |

This is R2's predicted blocker, now pinned to a real PC, a real symbol and a real source line on the
real firmware's real boot path — but note **it is fourth in line, not first**. See §8.

### 4.6 The `rer` abort, observed on the real boot path `[RAN]` + `[SRC]`

```
[ERROR] cpu: CPU abort [PC=0x4009BAC2]: reading from external register not yet supported.
```

`0x4009BAC2` is `rer a8, a8`, inside `panic_handler` via inlined `xt_utils_dbgr_is_attached`
(`esp-idf/components/xtensa/include/xt_utils.h:204`).

R2 §3.6 found this in isolation and called it "not on the happy boot path, but the first time the
firmware panics, Renode dies instead of printing a backtrace." **That is now confirmed against the
real firmware:** the very first fault the boot takes leads, within ~15 instructions, to an emulator
abort. Every diagnostic you would want at that moment is destroyed. This moves R2's item 2(b) from
"cheap nice-to-have" to **prerequisite for all further debugging**.

### 4.7 Peripheral registers the boot actually touches — observed, not guessed

Rung E leaves every window except EXTMEM unmapped, so the system bus logs each access.
`[RAN]` `logs/r4-exp5-sesame-observe.log`, 50 distinct addresses:

| Peripheral (base, `reg_base.h`) | Observed addresses | Touched by |
|---|---|---|
| **SPI1 flash** `0x3F402000` | `…000, 004, 008, 018, 01C, 020, 024, 028, 058, 0DC` | `bootloader_flash_execute_command_common`, `bootloader_read_flash_id` |
| **SPI0** `0x3F403000` | `…0DC` | `spimem_flash_ll_get_source_freq_mhz` |
| **FE2** `0x3F405000` / **FE** `0x3F406000` | `…0F0`, `…090` | `rtc_sleep_pd` |
| **RTCCNTL** `0x3F408000` | 20 addresses: `…000, 01C, 020, 024, 028, 02C, 034, 038, 040, 04C, 074, 080–098, 0A8, 0AC` | `rtc_init`, `rtc_clk_*`, RTC-WDT `wdt_hal_*` |
| **SENS** `0x3F408800` | `…808, 83C` | `sar_periph_ctrl_init` |
| **I2S** `0x3F40F000` | `…0A4` | `rtc_sleep_pd` |
| **EFUSE** `0x3F41A000` | `…034` | `efuse_hal_*` (chip / block revision) |
| **NRX** `0x3F41CC00` / **BB** `0x3F41D000` | `…CD4`, `…054` | `rtc_sleep_pd` |
| **TIMG0** `0x3F41F000` / **TIMG1** `0x3F420000` | `…048, 064` on each | `wdt_hal_disable`, `wdt_hal_write_protect_*` |
| **SYSCON** `0x3F426000` | `…098` | clock gating |
| **SYSTEM** `0x3F4C0000` | `…000, 008, 018, 03C` | `periph_ll_enable_clk_clear_rst` |
| **SENSITIVE** `0x3F4C1000` | `…07C, 0D8` | ROM `Cache_Allocate_SRAM` |
| **EXTMEM** `0x61800000` | `…000, 004, 040, 044, 11C` | ROM cache suspend / resume / invalidate / autoload |

Static cross-check over the whole ELF (`l32r` literals landing in a peripheral window, attributed to
their containing function) `[RAN]`:

```
RTCCNTL 70   SYSTEM 66   AES 23   SYSCON 18   EXTMEM 18   SPI1 15   SHA 14   SPI0 13
EFUSE 12     RSA 12      GPIO 11  I2C0 10     UART0 9     RTCIO 8   TIMG0 8  IO_MUX 8
SENS 6       UART1 4     MMU_TABLE 3  SPI2 3  SPI3 3      SYSTIMER 2  I2S 2  USB 1
BB 1  NRX 1  FE 1  FE2 1  TIMG1 1  LEDC 1  USB_WRAP 1  APB_SARADC 1
```

`LEDC` shows only one literal reference (`ledcAttachChannel`) because the LEDC HAL addresses
registers through a struct pointer, not a literal — a reminder that literal counts are a lower
bound, not a measurement of importance. `[INFER]`

---

## 5. The specific hardware behaviours a RAM shim cannot fake

Every entry in `r4-shim-seeds.resc` is a place where boot code writes a bit and then polls for the
hardware to change one. Storage is not enough; each needs behaviour. All `[RAN]`, all decoded from
the ROM disassembly.

| Register | Bit | Spinning code | What must happen |
|---|---|---|---|
| `EXTMEM 0x61800040` | 19 | ROM `Cache_Suspend_ICache_Autoload`, `0x400184BC` `bnone a10, 0x80000` | autoload-done must set after bit 18 is cleared |
| `EXTMEM 0x61800040` | 21 | ROM `Cache_Suspend_ICache`, `0x40018CC0` `bnone a9, 0x200000` | suspend-done must set |
| `EXTMEM 0x6180011C` | `[11:0]` | ROM `Cache_Suspend_ICache`, `0x40018CCC` `bnei a3, 1` | cache state must read 1 |
| `EXTMEM 0x61800040` | 9 | ROM `Cache_Invalidate_ICache_Items`, `0x400181F5` | invalidate-done must set after bit 8 |
| `EXTMEM 0x61800000` | 9 (+19, 21) | ROM `Cache_Invalidate_DCache_Items`, `0x40018245` | DCache mirror of the above |
| `SPI1 0x3F402000` | 18 (`SPI_MEM_USR`) | `bootloader_flash_execute_command_common`, `0x40025185` / `0x400253BE`, `bootloader_flash.c:845` | the command bit must **self-clear** on completion, and a flash device must answer |

One wrong guess is recorded in the seeds file rather than quietly deleted: `0x61800044` was seeded
first, by symmetry with the ICache register, and changed nothing — the DCache control register is
`0x61800000`, verified in the ROM disassembly at `0x4001822A`. A wrong guess that costs one run is
cheaper to write down than to rediscover.

---

## 6. Corrections and additions to earlier findings

### 6.1 R2 item 1 (`salt`/`saltu`) — confirmed, but **not** the first blocker

R2 called it a "HARD BOOT BLOCKER" via `heap_caps_init()`. It is a hard blocker, and R4 observed it
— but the boot dies **three times over** before reaching it. Ranked by when they bite:
boot state → ROM → EXTMEM → `saltu`. R2 was measuring below the CPU line and explicitly said
everything above it was unanswered; this is the answer.

Static counts re-derived independently and agreeing with R2: **196 total (`saltu` 163, `salt` 33)**.
Top containing functions `[RAN]`: `mbedtls_mpi_core_mla` 19, `esp_psram_init` 10,
`mmu_hal_check_valid_ext_vaddr_region` 6, `s_do_mapping` 5, `cache_hal_vaddr_to_cache_level_id` 5,
`_dtoa_r` 4, `heap_caps_check_add_region_allowed` 4.

### 6.2 R2 item 4 (CCOMPARE map) — **downgraded**; it is not a boot blocker

R1 §8.1 / R2 item 4 said the hardcoded `{6, 10, 13}` in
`renode-infrastructure/src/Emulator/Cores/Xtensa/Xtensa.cs:150-158` "BLOCKS the FreeRTOS tick".
Checking the actual configuration: `[SRC]`

- `xtensa/esp32s2/include/xtensa/config/core-isa.h:498-500` — `XCHAL_TIMER0_INTERRUPT 6`,
  `XCHAL_TIMER1_INTERRUPT 15`, `XCHAL_TIMER2_INTERRUPT 16`
- `esp32s2-libs/3.3.11/sdkconfig:1700` — `CONFIG_FREERTOS_SYSTICK_USES_CCOUNT=y`
- `esp32s2-libs/3.3.11/sdkconfig:1698` — `CONFIG_FREERTOS_CORETIMER_0=y`

So the tick uses **CCOMPARE0 → CPU interrupt 6**, and Renode's `intMap[0]` is **6 — correct**. Only
`CCOMPARE1` (15 vs 10) and `CCOMPARE2` (16 vs 13) are wrong, and those serve `esp_pm` and
cross-core paths that this single-core, non-PM build does not exercise on the boot path.
**Re-cost: 0.5 d correctness fix, not a boot blocker.** `[SRC]` + `[INFER]`

### 6.3 R2 item 2 (`rer`) — **upgraded** to prerequisite

Not because it is on the happy path (it is not) but because it is on the *unhappy* path, which is the
only path we can currently observe (§4.6).

### 6.4 New: on the `s2mini` profile, `Serial` is **USB-CDC, not UART0** `[SRC]` + `[RAN]`

`firmware/artifacts/s2mini/build-manifest.json:92` records the resolved build flags:

```
-DARDUINO_USB_MODE=0 -DARDUINO_USB_CDC_ON_BOOT=1
```

and the linked ELF contains both `USBSerial` (`0x3FFC9F64`) and `Serial0` (`0x3FFCAB80`). With
`ARDUINO_USB_CDC_ON_BOOT=1`, Arduino-ESP32 aliases `Serial` to `USBSerial` — the TinyUSB CDC device
on the S2's USB-OTG peripheral at `0x60080000` / `0x3F439000` — **not** UART0 at `0x3F400000`.

**Consequence for R6/R7 Path A:** the `@SESAME` telemetry R6 emits through `Serial` would not appear
on R3's tcp/3456 UART0 socket even if the firmware booted. Three ways out, and two of them are free:

- build the telemetry profile with `CDCOnBoot=dis_cdc` (this board's spelling for "Disabled", per
  `firmware/build/sketch.yaml`), routing `Serial` → `Serial0` → UART0 — **profile change, ~0 d**; or
- have the patch emit on `Serial0` explicitly — **~0 d**, and it leaves the USB console alone; or
- model USB-CDC — **8–15 d**, and unnecessary.

This was invisible until something tried to boot, and it is worth acting on now.

### 6.5 New: the no-aliasing simplification has not bitten yet

R3 §7.5 predicted the separate `iram`/`dram` regions would be what bites R4. It has not, because the
boot dies before IDF's IRAM-attribute setup. It remains a live risk for anything past
`system_early_init`. `[INFER]`

---

## 7. Feasibility assessment of the `salt`/`saltu` fix — assessment only, nothing was built

The scope guard forbids building Renode or patching tlib. This section locates the change and sizes
it; it does not make it.

### 7.1 Root cause, exactly `[SRC]`

`renode-infrastructure` pins tlib as a submodule at `antmicro/tlib`
`c0c259ae8f3ed432353cbbf8922404e5d05ee614`. In that tree:

- `arch/xtensa/core-esp32/` has `core-isa.h` **and** `xtensa-modules.c.inc` (461 802 bytes).
- `arch/xtensa/core-esp32s2/` and `core-esp32s3/` have **`core-isa.h` only — no modules file.**
- `arch/xtensa/core-esp32s2.c` reads, verbatim:

```c
#include "core-esp32s2/core-isa.h"
#define xtensa_modules xtensa_modules_esp32s2
//  use the common implementation of ESP32
#include "core-esp32/xtensa-modules.c.inc"
```

`core-esp32s3.c` is identical with `s3` substituted. **The ESP32 (LX6) opcode table is reused for
both LX7 cores.** `salt`/`saltu` and the dedicated-GPIO TIE ops are LX7 additions, so they are
absent — not because tlib cannot execute them, but because the S2/S3 configs borrow the wrong table.
That also explains R2's observation that `de233_fpu` runs them: it has its own generated table.

The semantics are already present and unconditional: `arch/xtensa/translate.c:2053`
`static void translate_salt(...)`, registered at lines 4672 (`"salt"`) and 4677 (`"saltu"`).
`"rer"` (3699, `translate_rer` → `gen_helper_rer`) and `"wer"` (4798) are registered too.
**No new translator code is required for `salt`/`saltu` — only a table that names them.**

### 7.2 A generated LX7 table exists upstream `[SRC]`

`espressif/qemu`, branch `esp-develop`, `target/xtensa/core-esp32s3/xtensa-modules.inc.c`
(1 312 360 bytes) is a properly generated LX7 module table. Downloaded and inspected: it contains
`"salt"`, `"saltu"`, `Opcode_salt_Slot_inst_encode`, `Opcode_saltu_Slot_inst_encode` and 9
occurrences of `set_bit_gpio_out`. It ships alongside `core-esp32s3/core-isa.h` and
`translate_tie_esp32s3.c` (the TIE semantics).

There is **no** `core-esp32s2` directory in any public QEMU fork checked (`espressif/qemu`
`esp-develop` and `esp-develop-based-on-9.2.2`; `qemu/qemu` `master`). So for the S2:

- **(a)** point `core-esp32s2.c` at Espressif's *S3* LX7 table. Over-permissive — it accepts S3-only
  encodings the S2 lacks — but it rejects nothing the S2 emits, and it is strictly more accurate
  than today's LX6 table. This is the same trade-off tlib already made, only in the right direction.
- **(b)** generate a true S2 table, which needs Cadence Xtensa Processor Generator output Espressif
  has not published. Not available.

### 7.3 Re-cost

| Work | Estimate | Note |
|---|---|---|
| Stand up a tlib + Renode build on this Windows host | **1–2 d, one-off** | the real cost; nobody has done it. Renode's portable build is .NET plus a native tlib per architecture |
| Drop in Espressif's LX7 modules table + `core-isa.h`, change two `#include` lines, rebuild | **0.5 d** | mechanical |
| Verify with R2's rung-5 probe (which already tests `salt`/`saltu` explicitly) and re-run R4 rung E | **0.5 d** | the regression harness exists |
| Dedicated-GPIO TIE semantics (`translate_tie_esp32s3.c` equivalent) | **2–3 d** | separate, deferrable, not on the boot path |

**Revised: `salt`/`saltu` itself is ~1 d, cheaper than R2's 1–2 d, but gated behind a 1–2 d one-off
build bring-up.** The interesting change is not the number — it is that the fix is a *file drop from
an official upstream source* rather than opcode-table authoring, which removes most of the risk from
the estimate.

---

## 8. Gate A above the CPU line

R2 answered Gate A **below** the CPU line: **YES** — Renode 1.16.1 executes real
`xtensa-esp32s2-elf-gcc 14.2.0` output; windowed ABI, window exceptions, `memw`, 41/43 special
registers, all five memory regions, 49/54 opcode probes. R4 does not disturb any of that, and
independently corroborates it (§4.3).

> ### Gate A above the CPU line: **NO, today.** The blocker is the SoC, not the processor.
>
> Nothing above the CPU exists. There is no boot ROM (R4 supplied one), no cache controller, no
> flash controller, no clock tree, no interrupt matrix, no timers, no GPIO matrix, no LEDC, no ESP32
> I²C, no SSD1306, and — for the `s2mini` profile as built — no USB-CDC. The measured consequence is
> that **`setup()` is 0 of 20 `bootOrder` steps away and 34 startup functions short**.
>
> **But it is bounded, ordered and priced.** §9 lists every blocker with an observed PC or a counted
> static reference. The path to *user code executing* — as distinct from a faithful robot — runs
> through eleven items totalling **≈16–25 engineering days** by the line items in §9.1, of which one
> (the boot ROM) is already delivered and two (`salt`/`saltu`, `rer`) are upstream one-liners behind
> a build.
>
> **Corrected 2026-08-23 (phase-0 closeout):** this line originally read "≈18–30 engineering days".
> That figure does not sum from §9.1's own table — the line items give 15.25–23.25 d, or ≈16–25 d
> once the 1–2 d one-off build bring-up is added. The headline was padded in the prudent direction,
> which is defensible, but it was presented as a sum. **≈16–25 d is the sum; ≈18–30 d is the padded
> band**, and both are now labelled as such wherever they appear. See §9.1.
>
> This does **not** change the Phase-0 recommendation: the behavioural simulator stays primary and
> the instrumented-firmware telemetry path (R6 / Gate B) stays the way the robot gets driven. What
> changes is that "full-Renode emulation" is now a costed backlog item rather than an open-ended
> research risk — and that Wi-Fi, which `bootOrder` steps 6–15 depend on, has no credible price at
> all.

---

## 9. The costed backlog

Effort is engineering days for someone with the toolchain in hand. "Blocks boot" means *user
`setup()` cannot be reached without it*. Evidence is an observed PC/address from a run on this
machine, or a counted static reference in the real ELF.

### 9.1 Critical path to reaching `setup()`

| # | Item | Evidence | Blocks boot | Est. |
|---|---|---|---|---|
| 1 | **Boot-ROM machine state** (`PS.WOE`, `SP`, window state) | PC `0x40025738`, `Illegal entry instruction`, instruction #0 `[RAN]` | **YES** | **0.25 d** — `r4-bootstate.resc` already does it; fold into the platform or model a ROM reset |
| 2 | **ESP32-S2 mask-ROM image** | PC `0x4000FF58` abort `[RAN]`; 126 symbols / 1209 refs `[RAN]` | **YES** | **DONE, 0.25 d** — `scripts/fetch-esp32s2-rom.mjs` + `esp32s2-rom.repl` |
| 3 | **EXTMEM cache controller** `0x61800000` | spin at ROM `0x400184BE`; five status bits enumerated in §5 `[RAN]` | **YES** | **2–3 d** — register model with self-completing suspend/resume/invalidate/autoload + MMU/tag-table RAM |
| 4 | **`salt` / `saltu` in the esp32s2 core config** | `saltu a2,a10,a8` at PC `0x400E6AD2`, `s_get_bus_mask`, `cache_ll.h:473` `[RAN]`; 196 static uses `[RAN]`; root cause in `core-esp32s2.c` `[SRC]` | **YES** | **1 d** + **1–2 d one-off** tlib/Renode build bring-up (§7) |
| 5 | **`rer` / `wer` abort → recoverable** | `rer a8, a8` at PC `0x4009BAC2` in `panic_handler` kills the emulator `[RAN]` | not directly, but **blocks all diagnosis** | **0.5 d** (downgrade to `ILLEGAL_INSTRUCTION`); 2–3 d for a real external-register file |
| 6 | **SPI0 / SPI1 flash controller** `0x3F402000` / `0x3F403000` + a flash device | spin at `0x40025185` / `0x400253BE`, `bootloader_flash.c:845`; 10 SPI1 registers observed `[RAN]` | **YES** | **5–8 d** — self-clearing `SPI_MEM_USR`, read-ID / read-data backed by `sesame-firmware-main.ino.bin`; also needed for XIP, SPIFFS and `mspi_timing_flash_tuning` |
| 7 | **RTCCNTL + clock tree** `0x3F408000` | 20 observed addresses `[RAN]`; 70 static refs; `rtc_init`, `rtc_clk_*`, `esp_clk_init` `[RAN]` | **YES** | **3–5 d** |
| 8 | **SYSTEM clock/reset gating** `0x3F4C0000` | `…000/008/018/03C` observed `[RAN]`; 66 static refs; `periph_ll_enable_clk_clear_rst` gates every other peripheral | **YES** | **2–3 d** |
| 9 | **SENSITIVE** `0x3F4C1000` | `0x3F4C107C`, `0x3F4C10D8` observed in ROM `Cache_Allocate_SRAM` `[RAN]` | **YES** | **0.5–1 d** — mostly a plausible register file |
| 10 | **EFUSE** `0x3F41A000` | `0x3F41A034` observed `[RAN]`; `efuse_hal_blk_version`, chip-revision checks | **YES** (IDF asserts on revision) | **0.5–1 d** — constant-valued block |
| 11 | **IRAM/DRAM aliasing** (`0x4002xxxx` ↔ `0x3FFBxxxx`) | not yet hit; `esp32s2-sesame.repl` note 1 `[SRC]` | likely, past `system_early_init` | **0.5 d** — one memory, two sysbus mappings |

**Subtotal to plausibly reach `setup()`: 15.25–23.25 d** (items 1, 3–11), of which item 2 is already
delivered. Add the 1–2 d one-off build bring-up and the sum is **≈16–25 d**.

> **Corrected 2026-08-23 (phase-0 closeout):** this originally read "≈16–27 d … realistic band
> ≈18–30 d". Neither number sums from the table above. Adding the low ends of items 1 and 3–11 gives
> 0.25 + 2 + 1 + 0.5 + 5 + 3 + 2 + 0.5 + 0.5 + 0.5 = **15.25 d**; the high ends give 0.25 + 3 + 1 +
> 0.5 + 8 + 5 + 3 + 1 + 1 + 0.5 = **23.25 d**. With the 1–2 d bring-up that is **≈16–25 d**.
> The original ≈18–30 d was padding for unstated integration overhead, not arithmetic. It is a
> reasonable thing to carry — a register-modelling exercise with no calibration point should not be
> quoted at its floor — but it must be quoted as **padding on top of a ≈16–25 d sum**, never as the
> sum itself. Independently re-checked by `gate-reporter` (Gate A §4.2).

### 9.2 Needed for the firmware to *work*, once it boots

| # | Item | Evidence | Blocks | Est. |
|---|---|---|---|---|
| 12 | **Interrupt matrix** `0x3F4C2000` (85 sources, `interrupts.h`) | not yet observed — boot dies first; `esp_rom_route_intr_matrix` ×6 `[RAN]`; `IRQ -> cpu@5` in the `.repl` is an admitted placeholder `[SRC]` | every interrupt-driven path: UART RX, timers, I²C, Wi-Fi | **3–5 d** |
| 13 | **SYSTIMER** `0x3F423000` | `CONFIG_ESP_TIMER_IMPL_SYSTIMER=y` (`sdkconfig:1497`) `[SRC]` — backs `esp_timer`, therefore `micros()` / `millis()` / `delay()` | **every movement sequence** in `hardware-map.movements` is `setServoAngle` + `delay` | **2–3 d** |
| 14 | **CCOMPARE→IRQ map**, `Xtensa.cs:150-158` | `{6,10,13}` vs `{6,15,16}` (`core-isa.h:498-500`) `[SRC]` | nothing on this build (§6.2) — CCOMPARE1/2 only | **0.5 d** |
| 15 | **TIMG0 / TIMG1 watchdogs** `0x3F41F000` / `0x3F420000` | `…048`, `…064` observed on both `[RAN]` | nothing (absence is permissive); needed for fidelity — a hung firmware should reset | **2–3 d** |
| 16 | **GPIO matrix + IO_MUX** `0x3F404000` / `0x3F409000` | 11 + 8 static refs; `__pinMode`, `gpio_output_enable`, `esp_rom_gpio_connect_out_signal` ×15 `[RAN]` | servo pins, any digital I/O | **2–3 d** |
| 17 | **LEDC** `0x3F419000` | `ledcAttachChannel`; `bootOrder` steps 16–17 (`.ino:734`, `:739`); ESP32Servo 3.0.9 | **Gate B via emulated peripheral** — duty → pulse width → angle | **3–5 d** |
| 18 | **I²C master** `0x3F413000` | 10 static refs; `bootOrder` step 3 (`.ino:656`) | steps 3–5 | **3–5 d** |
| 19 | **SSD1306 device model** on that I²C bus | `bootOrder` step 4 (`.ino:659`) **hard-fails into `while(1)` at `.ino:662`** (F4) | steps 4–20 for unmodified firmware | **2–3 d** |
| 20 | **UART0 model gaps** | R3 §4: `UART_INT_ST` (0x08) unimplemented; `0x74`/`0x78` are `UART_DATE`/`UART_ID` on the S2, the model decodes the S3/C3 layout `[RAN]` | interrupt-driven serial; `HardwareSerial` init | **1 d** upstream |
| 21 | **USB-CDC** `0x60080000` / `0x3F439000`, **or** rebuild with `CDCOnBoot=dis_cdc` | `-DARDUINO_USB_CDC_ON_BOOT=1` (§6.4) `[SRC]` | `Serial` output, including R6 telemetry | **0 d** (profile change) vs **8–15 d** (model). Take the 0 |
| 22 | **Wi-Fi / PHY / MAC** (`0x6001Cxxx`, `0x3F41Cxxx`, `0x3F41Dxxx`, SYSCON PHY gating) | 18 SYSCON refs from `phy_module_enable` / `wifi_module_enable`; `rtc_sleep_pd` touches FE/FE2/BB/NRX `[RAN]` | `bootOrder` steps 6–15 (AP, mDNS, DNS, HTTP) | **out of scope, not costed.** Nobody emulates ESP32 Wi-Fi; plan to stub the API, not the radio |
| 23 | Dedicated-GPIO TIE ops | R2 item 3; 8 uses, mostly disassembled data | nothing Sesame uses | **2–3 d**, defer |
| 24 | AES / SHA / RSA (`0x6003Axxx`…) | 23 / 14 / 12 static refs, all flash-encryption and mbedTLS paths | nothing on this boot | **defer** |
| 25 | No unaligned-access exception (R2 item 7) | R2 §3.5 | fidelity only — the emulator is *more* permissive than silicon | **defer** |

### 9.3 The shape of the answer

- **Reaching `setup()`:** **≈16–25 d** by line item (≈18–30 d if the padded band is preferred; see
  the correction in §9.1), dominated by the flash controller, the clock tree and the cache
  controller. None of it is research; all of it is register-level modelling against Espressif
  headers already on this machine.
- **A robot that moves:** add items 12, 13, 16, 17 → **+10–16 d**.
- **Unmodified firmware all the way to `bootOrder` step 20:** add 18, 19 and a Wi-Fi API stub — and
  Wi-Fi is the item nobody should price optimistically.
- Items 2 and 21 are already solved or are configuration changes. Items 4, 5, 14 and 20 total ~3 d
  of upstream contribution that would benefit every future ESP32 user of Renode.

---

## 10. The `de233_fpu` diagnostic — NON-AUTHORITATIVE

> `de233_fpu` is a **different Xtensa configuration**, not an ESP32-S2. Its window, exception and
> special-register behaviour differ. Nothing in this section is evidence about the S2. It exists to
> answer one question: *how much further would the boot get if `salt`/`saltu` worked?*

Same memory map, same real ROM image, same EXTMEM shim, same seeds; only `cpuType` differs.
`[RAN]` `logs/r4-exp5-sesame-de233-observe.log`

**Result: substantially further.** Where `esp32s2` stopped after 34 functions at `s_get_bus_mask`,
`de233_fpu` executes `saltu` correctly, returns from `esp_mmu_map_init`, and continues into:

```
system_early_init
  esp_mspi_pin_reserve  esp_mspi_get_io  ets_efuse_get_spiconfig  ets_efuse_get_wp_pad
  esp_psram_io_get_cs_io  esp_psram_impl_get_cs_io  esp_gpio_reserve
  bootloader_init_mem
  esp_cpu_configure_region_protection  mpu_hal_set_region_access
  esp_clk_init
    rtc_clk_8md256_enabled  rtc_clk_8m_enable  ets_delay_us  xthal_get_ccount
    rtc_clk_fast_src_set  rtc_clk_slow_freq_get_hz  wdt_hal_feed
                                    <-- unrecognized opcode (pc = 4009bf7c) = muluh a11, a10, a7
```

It then panics — and this time the panic path **runs to completion**: `panic_handler` →
`esp_panic_handler_enable_rtc_wdt` → `panic_print_str` → `panic_print_char_uart` →
`uart_hal_write_txfifo` → `panic_restart` → `esp_restart_noos`. No emulator abort: `de233_fpu`
implements `rer`.

Three things this sharpens:

1. **`salt`/`saltu` is worth roughly 25 more startup functions** — from mid-`esp_mmu_map_init` to
   mid-`esp_clk_init`, through `system_early_init`, MPU region protection and the eFuse/PSRAM pin
   reservation. It does not reach `setup()`; the next wall is the clock tree (item 7).
2. **The stopping point here is an artefact of `de233_fpu`, not of the S2.** `muluh` at
   `0x4009BF7C` and `0x40143798` is *supported* on `esp32s2` (R2 §3.5, probes 16–48 passed). A core
   with both `salt` and `muluh` — i.e. a fixed `esp32s2` config — would get at least this far and
   then need RTCCNTL to behave.
3. Once past `salt`, **panic output reaches UART0** via `panic_print_char_uart`. Combined with R3's
   socket, a fixed core would give readable IDF panic backtraces on tcp/3456 — a large diagnostic
   win for a 1-day fix.

An earlier `de233_fpu` run with the *full* MMIO shim wedged in exactly the same SPI-flash spin as
`esp32s2` (`logs/r4-exp5-sesame-de233.log`, final PC `0x400253B9`, zero unrecognized opcodes),
which is the cleanest single demonstration that **the missing LX7 opcodes are not the binding
constraint on this boot.**

---

## 11. Re-runnable commands

Every run below is timeout-guarded. **Never invoke `renode.exe` bare for these scripts** — rung E
ends in a `rer` abort from which `emulation RunFor` never returns and the process must be killed.

```bash
# --- one-time setup ------------------------------------------------------
node firmware/probes/build-r4-arduino.mjs          # build the Experiment-4 sketch (F3 profile)
node scripts/fetch-esp32s2-rom.mjs                 # fetch + verify + slice the ESP32-S2 mask ROM

# --- Experiment 4: minimal Arduino sketch --------------------------------
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-arduino-min.resc            r4-exp4-arduino            120
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp4-arduino-bootstate.resc r4-exp4-arduino-bootstate   90
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp4-arduino-rom.resc       r4-exp4-arduino-rom        120
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp4-arduino-shim.resc      r4-exp4-arduino-shim       180   # [DIAG]

# --- Experiment 5: the real Sesame S2 ELF --------------------------------
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-stock.resc      r4-exp5-sesame-stock       150   # AUTHORITATIVE
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-bootstate.resc  r4-exp5-sesame-bootstate   200
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-rom.resc        r4-exp5-sesame-rom         240
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-shim.resc       r4-exp5-sesame-shim        300   # [DIAG]
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-shim-trace.resc r4-exp5-sesame-shim-trace  300   # [DIAG] symbol trace
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-observe.resc    r4-exp5-sesame-observe     300   # [DIAG] rung E - the far one

# --- de233_fpu diagnostic (NON-AUTHORITATIVE) ----------------------------
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-de233.resc         r4-exp5-sesame-de233         300
node emulator/renode/tests/r4-run.mjs emulator/renode/scripts/r4-exp5-sesame-de233-observe.resc r4-exp5-sesame-de233-observe 300
```

Decoding a PC afterwards:

```bash
TC=tools/arduino-data/data/packages/esp32/tools/esp-x32/2601/bin
# application PC
$TC/xtensa-esp32s2-elf-addr2line.exe -f -e firmware/artifacts/s2mini/sesame-firmware-main.ino.elf 0x400E6AD2
# ROM PC (0x40000000 .. 0x4001FFFF)
$TC/xtensa-esp32s2-elf-addr2line.exe -f -e tools/esp-rom-elfs/esp32s2_rev0_rom.elf 0x400184BE
$TC/xtensa-esp32s2-elf-objdump.exe -d --start-address=0x40018498 --stop-address=0x400184C4 \
    tools/esp-rom-elfs/esp32s2_rev0_rom.elf
```

### 11.1 On GDB

Renode's GDB server works here (R1 §7: `cpu GDBArchitecture` = `xtensa`) and GDB 17.1 is at
`tools/arduino-data/data/packages/esp32/tools/xtensa-esp-elf-gdb/17.1_20260402/bin/xtensa-esp-elf-gdb-no-python.exe`.
**R4 did not need it and deliberately did not use it.** `cpu LogFunctionNames true true` plus
`addr2line` produced a complete, ordered, file-and-line-resolved boot trace in a single
non-interactive run, which is reproducible in CI; an interactive GDB session is not. GDB becomes the
right tool once execution survives a fault — that is, after item 5 (`rer`) is fixed. Recorded as a
deliberate choice, not an omission. To enable it, add to any script above:

```
machine StartGdbServer 3333 true
```

then `target remote :3333` from the no-python GDB with the ELF loaded.

---

## 12. What the next agent should take from this

1. **The `bootOrder` ladder is not the ladder.** Everything Phase 0 cared about — serial, I²C, OLED,
   Wi-Fi, servos — sits above 34 ESP-IDF startup functions that must run first. Cost the startup,
   not the sketch.
2. **`salt` was not the first blocker and it is not the biggest.** The SoC is. R2's CPU-level list is
   correct and cheap; items 3, 6, 7 and 8 in §9.1 carry the weight.
3. **Fix `rer` first in any real effort** (item 5, 0.5 d). Until then the emulator dies at the exact
   moment it becomes interesting.
4. **The ROM is solved.** `node scripts/fetch-esp32s2-rom.mjs` and it is there, with symbols, so ROM
   frames resolve by name in traces.
5. **Tell R6/R7 about `ARDUINO_USB_CDC_ON_BOOT=1`** (§6.4). It costs nothing to fix now and silently
   breaks Path A later.
6. **Phase 0's conclusion is unchanged and now evidenced:** behavioural simulator primary,
   instrumented firmware for Gate B, Renode as a research track with a **~16–25 day** price tag to
   reach user code (§9.1, corrected 2026-08-23) and no Wi-Fi story at any price.
