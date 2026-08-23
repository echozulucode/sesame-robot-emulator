# R2 · Real-compiler-output Xtensa execution probe (Experiment 2)

**Task:** R2 (Phase 0, Workstream R) · **Agent:** `renode-platform` · **Date:** 2026-08-23
**Status:** complete
**Headline:** Renode 1.16.1 executes real `xtensa-esp32s2-elf-gcc 14.2.0` output, including the
full windowed ABI and all six register-window overflow/underflow handlers. The ladder passed
end to end. Five instruction encodings and two special registers are missing, and one of them —
`rer` — hard-aborts the emulator rather than raising an exception. **Gate A: YES, with a named,
small, bounded fix list.**

---

## 0. Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | **verified-by-running** on this machine. Log output quoted or summarised from a real run |
| `[SRC]` | **found-in-source** — read out of a file on this machine (Espressif header/linker script, disassembly of a real ELF, or a string inside `renode.exe`) |
| `[INFER]` | **inferred**. Reasoned, not observed |

Nothing in this document is quoted from a datasheet or from memory. Every ESP32-S2 address and
every claim about "what real firmware does" comes from files installed under `tools/` by F3.

---

## 1. Why R2 was re-scoped

R1 already proved Renode runs `cpuType: "esp32s2"` and retires instructions (a hand-assembled
six-instruction MOVI/L32I/QUOU/J sequence). R1's own closing section said the real Gate-A
question was different:

> *"Whether the `esp32s2` tlib core config enables the options real ESP-IDF code uses — windowed
> registers (`entry`/`retw`), `WSR`/`RSR` of ESP32-specific special registers, cache control
> instructions, `memw`. Our six-instruction test touched none of these."*

So R2 is scoped to exactly that: **does the core execute what the compiler actually emits?**

### 1.1 What the compiler actually emits — measured, not assumed

The target was defined empirically by disassembling the real, linked S2 firmware F3 produced
(`firmware/artifacts/s2mini/sesame-firmware-main.ino.elf`, ELF SHA-256
`5436d303…9eedfd`) with `xtensa-esp32s2-elf-objdump -d`. `[SRC]`

**135,118 instructions, 205 distinct mnemonics.** The ones that matter:

| Count | Mnemonic | Why it matters |
|---:|---|---|
| 11,108 | `l32r` | literal pools — PC-relative, silently wrong if the link address is wrong |
| 6,589 / 4,464 | `call8` / `callx8` | the windowed ABI, direct and indirect |
| 4,157 | `memw` | ordering barrier around every MMIO access |
| 3,113 / 3,075 | `entry` / `retw`+`retw.n` | windowed frame setup and return |
| 196 | `saltu` (163) + `salt` (33) | LX7 set-on-less-than |
| 115 | `l32e` (71) + `s32e` (44) | window spill/fill in the exception handlers |
| 100 / 55 / 46 | `call0` / `call4` / `call12` | the other window increments |
| 38 | `rsil` | interrupt-level changes |
| 25 | `rotw` | window rotation (`_xt_alloca_exc`) |
| 22 | TLB ops (`witlb` 5, `ritlb0` 5, `pitlb` 4, `pdtlb` 3, `ritlb1` 2, `wdtlb` 2, `rdtlb0` 1) | IDF region protection |
| 8 | `set_bit_gpio_out`, `clr_bit_gpio_out`, `wr_mask_gpio_out` | ESP32-S2 dedicated-GPIO TIE ops |
| 6 | `rer` | read external register |
| 4 | `rur`/`wur.threadptr` | FreeRTOS thread-local storage |
| **0** | any Xtensa cache instruction (`dhwb`, `ihi`, `dhi`, `ipf`, …) | see §1.2 |

**39 distinct special/user registers** appear, across 65 distinct
`rsr.`/`wsr.`/`xsr.`/`rur.`/`wur.` operations. All 39 are listed in
`firmware/probes/r2/sr_list.h` with their occurrence counts, and all 39 were probed - plus five
extras (`cpenable`, `configid0`, `misc0`, `ccompare1`, `ccompare2`) that the Sesame image does not
use but any FreeRTOS/coprocessor path would.

**Caveat, stated honestly:** `objdump -d` disassembles literal pools and `.rodata`-in-`.text` as
if they were instructions, so a handful of the rarer counts (notably inside `_stext` and
`usb_persist_shutdown_handler-0xd50`, which are padding/data regions) are decoding artefacts.
Where a count is load-bearing below, the containing function is named and the surrounding
instructions were read to confirm it is real code.

### 1.2 Two capabilities the ESP32-S2 core simply does not have

Found before Renode was even involved, by feeding the instructions to the *toolchain*: `[RAN]`

```
r2/rung4_sr.c: Assembler messages:
  Error: unknown opcode or format name 'wsr.scompare1'
  Error: unknown opcode or format name 'rsr.scompare1'
  Error: unknown opcode or format name 'rsr.atomctl'
  Error: unknown opcode or format name 'wsr.atomctl'
r2/rung5_mem.c: Assembler messages:
  Error: unknown opcode or format name 'dhwb'   'dhwbi'  'dhi'
  Error: unknown opcode or format name 'ihi'    'ipf'    'dpfr'
  Error: unknown opcode or format name 's32c1i'
```

`xtensa-esp32s2-elf-as 14.2.0` rejects them for the S2 core configuration. So:

- **No conditional store** (`s32c1i` / `SCOMPARE1` / `ATOMCTL`). The S2 is single-core; ESP-IDF
  uses interrupt masking, not LL/SC.
- **No Xtensa cache instructions.** The ESP32-S2's cache lives *outside* the Xtensa core and is
  driven over MMIO. This is corroborated by the real image containing zero of them in 135,118
  instructions.

Consequence for Renode: two whole categories of "missing feature" are removed from the risk list
before any emulation happens. "Does Renode implement Xtensa cache control?" is a non-question for
this target.

---

## 2. How the ladder is built and run

Sources: `firmware/probes/r2/` (checked in). Build: `bash firmware/probes/build-probes.sh`,
which invokes the **per-target** driver
`tools/arduino-data/data/packages/esp32/tools/esp-x32/2601/bin/xtensa-esp32s2-elf-gcc.exe`
(14.2.0) — never the unified `xtensa-esp-elf-gcc`, per F3 §1.

Compiler flags mirror the real `esp32s2-libs/3.3.11/flags/c_flags` where codegen is affected:
`-Os -std=gnu17 -mlongcalls -mtext-section-literals -fstrict-volatile-bitfields
-fno-jump-tables -fno-tree-switch-conversion`, plus `-nostdlib -nostartfiles -ffreestanding`.

**The ABI is the experimental variable.** Rung 1 is the only rung built `-mabi=call0`; rungs 2–5
use the windowed ABI, which is ESP32 GCC's default and what `esp32s2-libs`' own flag files use
(no `-mabi=call0` anywhere in them). Rung 1 and rung 2 therefore differ in the ABI and *nothing
else*, so any delta between them is attributable to register windows.

**Link layout** (`firmware/probes/r2/probe.ld`), sourced from
`esp32s2-libs/3.3.11/ld/memory.ld`: `[SRC]`

| Section | Address | Source |
|---|---|---|
| `.vectors` | `0x40024000` | `iram0_0_seg org = (0x40020000 + 0x2000 + 0x2000)`. The real Sesame ELF puts `.iram0.vectors` at exactly this address |
| `.text` | `0x40024400` | vectors are 0x400 long |
| `.data` / `.bss` | `0x3FFB4000` | `dram0_0_seg org = (0x3FFB0000 + 0x2000 + 0x2000)` |
| result mailbox | `0x3FFD0000` | fixed so the `.resc` can read it with plain `sysbus ReadBytes` |
| fault mailbox | `0x3FFD0100` | written by the exception handler |
| stack top | `0x3FFDDFF0` | below `dram0_0_seg` end `0x3FFDE000` |

**`firmware/probes/r2/vectors.S`** carries the six register-window handlers. They are
instruction-for-instruction identical to Espressif's own — taken by disassembling
`.iram0.vectors` in the real S2 ELF (`_WindowOverflow4` … `_WindowUnderflow12`), not written from
the ISA manual. `[SRC]`

It also installs a **skip-and-continue user/kernel exception handler** at `VECBASE+0x340`/`+0x300`
that records `EXCCAUSE`, `EPC1`, `EXCVADDR`, bumps a fault counter, advances `EPC1` past the
3-byte faulting instruction and `rfe`s. That is what lets a *single run* enumerate every register
and every opcode the core rejects, instead of dying on the first one.

**Run:**

```
bash firmware/probes/build-probes.sh          # build all probe ELFs
node emulator/renode/tests/run-r2-ladder.mjs  # run all five rungs, print verdicts
node emulator/renode/tests/count-window-vectors.mjs   # rung-3 window-vector proof
```

Individual rungs, by hand:

```
tools/renode/renode.exe --console --disable-xwt --plain \
    emulator/renode/scripts/r2-rung3-window.resc
```

Raw console output for every rung is committed under `emulator/renode/tests/logs/`.

Platform: the checked-in `emulator/renode/platforms/esp32s2-sesame.repl` (see R3 for its address
provenance). Renode `1.16.1.19220`, portable sidecar at `tools/renode/`. The system install at
`C:\Program Files\Renode` was not used and not touched.

---

## 3. The ladder, rung by rung

| Rung | What it isolates | Verdict |
|---|---|---|
| 1 | straight-line arithmetic, `call0` ABI, real ELF sections, literal pools | **PASS** |
| 2 | windowed ABI: `entry` / `retw` / `call8` / `callx8`, no overflow | **PASS** |
| 3 | register-window overflow **and** underflow, all six handlers | **PASS** |
| 4 | `memw`, sync ops, `rsil`, 43 special registers + `threadptr` | **PASS with 2 rejected SRs** |
| 5 | memory at real S2 addresses + all remaining instruction classes | **PASS with 5 rejected opcodes** |
| 5b | `rer` in isolation | **FAIL — hard emulator abort** |

Every rung reached its `0xD09EF00D` done-marker. `[RAN]`

```
rung                      verdict  guest-exceptions  renode-errors
r2-rung1-arith            PASS                    0              0
r2-rung2-call             PASS                    0              0
r2-rung3-window           PASS                    0              0
r2-rung4-sr               PASS                    2              0
r2-rung5-mem              PASS                    5              5
```

### 3.1 Rung 1 — baseline, `call0` ABI · PASS `[RAN]`

`firmware/probes/r2/rung1_arith.c`, ELF entry `0x4002441C`.

All five startup markers set (so `start.S` ran, `PS` was written, `.bss` was zeroed, C was
called and returned). **All 14 arithmetic results bit-exact**, checked by the runner against
values computed on the host:

```
add 0x12345723   sub 0x123455CD   xor 0x123456D3   and 0x00340078
slli 0x468ACF00  srli 0x002468AC  srai 0xFFFDA52F  mull 0x28F5C228
quou 0x001B40E1  remu 0x0000002D  extui 0x00000456 sext 0x00000078
minu 0x000000AB  mulsh 0x0000000C
```

Zero exceptions, zero Renode errors. The `-mabi=call0` disassembly confirms the isolation is
real: no `entry`, no `retw`, no `l32e`/`s32e` anywhere in the rung.

### 3.2 Rung 2 — windowed ABI · PASS `[RAN]`

`entry` ×3, `retw.n` ×3, one `call8`, one `callx8` through a `volatile` function pointer.

```
leaf_add(0x1234, 0x56)  -> 0x00001336   (expected 0x1336)
leaf_mix via callx8     -> 0x0001231D   (expected 0x1231D)
```

Zero exceptions, zero Renode errors. **The windowed ABI works.**

### 3.3 Rung 3 — register-window overflow/underflow · PASS · *the important one* `[RAN]`

R1 named this as "the single most likely failure point". It is not a failure point.

Three independent chains:

- 48-level recursion through a `volatile` function pointer, compiling to `callx8`. (The indirect
  call is load-bearing: at `-Os` GCC rewrites plain recursion into a loop via the accumulator
  transform, and the first version of this rung silently tested nothing until that was caught in
  the disassembly.)
- Hand-written `w4_chain` / `w8_chain` / `w12_chain` in `firmware/probes/r2/window_chains.S`,
  recursing 40 deep with `call4`, `call8` and `call12` respectively — because GCC only ever emits
  `call8`, and `call4`/`call12` are what force the Overflow4/12 and Underflow4/12 handlers.

```
callx8 depth-48 checksum : 0x00303498
w4_chain(40)             : 40
w8_chain(40)             : 40
w12_chain(40)            : 40
```

Correct return values are necessary but not sufficient — they would also hold if the register
file never overflowed. So `emulator/renode/scripts/r2-rung3-trace.resc` traces every retired PC
and `count-window-vectors.mjs` counts entries to each vector: `[RAN]`

```
traced instructions: 46269
  WindowOverflow4      entered 26 times
  WindowUnderflow4     entered 26 times
  WindowOverflow8      entered 78 times
  WindowUnderflow8     entered 78 times
  WindowOverflow12     entered 35 times
  WindowUnderflow12    entered 35 times
  KernelException      entered 0 times
  UserException        entered 0 times
  DoubleException      entered 0 times
```

**All six handlers fire, overflow and underflow counts match exactly, and no exception ever
escapes to the user, kernel or double-exception vector.** `s32e`, `l32e`, `rfwo`, `rfwu` and
`rotw` all execute correctly, and the spilled locals survive the round trip (a broken fill would
have produced a wrong checksum, not a crash).

### 3.4 Rung 4 — `memw`, sync ops, special registers · PASS, 2 rejected `[RAN]`

```
memw faults          : 0        value through memw : 0xC0FFEE01
isync/rsync/esync/dsync faults : 0 / 0 / 0 / 0
rsil faults          : 0 / 0    old PS 0x00050020   (WOE|UM|CALLINC=1 - correct for a call4 frame)
```

43 special registers plus the `threadptr` user register, each written and read back where that is
safe. **41 of 43 behave correctly.** Highlights:

| Register | Result |
|---|---|
| `PS`, `EPC1-4`, `EPC6`, `EPS2-3`, `EXCSAVE1-7`, `EXCCAUSE`, `EXCVADDR` | all read/write correctly |
| `WINDOWBASE` / `WINDOWSTART` | read `0x1` / `0x3` — live and consistent with a rotated window |
| `CCOUNT` | advancing (`0x0001DC54`) |
| `CCOMPARE0` / `1` / `2` | all three read/write |
| `VECBASE`, `MEMCTL`, `SAR`, `INTENABLE`, `INTCLEAR`, `INTERRUPT`, `PRID`, `DEBUGCAUSE` | correct |
| `IBREAKA0/1`, `IBREAKENABLE`, `DBREAKA0/1`, `DBREAKC0/1`, `CPENABLE`, `MISC0` | read/write |
| `CONFIGID0` | reads `0xC2ECFAFE` |
| `rur`/`wur.threadptr` | round-trips `0x3FFD0E00` — FreeRTOS TLS will work |
| **`rsr.litbase`** | **illegal instruction** at PC `0x40025078` |
| **`wsr.mmid`** | **illegal instruction** at PC `0x400250EC` |

Both faults reported `EXCCAUSE = 0` (IllegalInstructionCause) and vectored cleanly to the user
exception handler. Real occurrences in the Sesame image: `rsr.litbase` ×1 (in `TOUCH_v2_free_glob`,
a Wi-Fi/PHY blob), `wsr.mmid` ×1 (inside `_stext`, i.e. almost certainly disassembled data). **Neither
is on the boot path.**

Renode also logged four benign warnings while the breakpoint registers were written:

```
[WARNING] cpu: Setting watchpoints with IBREAK instructions isn't supported!
[WARNING] cpu: Setting watchpoints with DBREAK instructions isn't supported!
```

The registers themselves store and read back; only their *breakpoint effect* is unmodelled. That
matters only if firmware relies on hardware watchpoints (`esp_cpu_set_watchpoint`), which the
Sesame path does not.

### 3.5 Rung 5 — memory and remaining instruction classes · PASS, 5 rejected `[RAN]`

**Memory at real ESP32-S2 addresses — all five regions read/write correctly:**

| Region | Address probed | Value written and read back |
|---|---|---|
| DRAM (`dram0_0_seg`) | `0x3FFC0000` | `0xA5A50000` |
| IRAM as data (`iram0_0_seg`) | `0x4004C000` | `0xA5A5C000` |
| RTC fast, data view (`rtc_data_seg`) | `0x3FF9E100` | `0xA5A5E100` |
| RTC fast, instruction view (`rtc_iram_seg`) | `0x40070100` | `0xA5A50100` |
| RTC slow (`rtc_slow_seg`) | `0x50000200` | `0xA5A50200` |

Plus `s16i`/`l16ui`, `s8i`/`l8ui`, `l16si`, `l32ai`, `s32ri` — all correct.

**54 probes ran; 49 passed, 5 were rejected:**

```
   0..13  dram/iram/rtc memory, s16i, s8i, l16si, unaligned l16ui,
          l32ai, s32ri, nsau, nsa, clamps                        ok
   14     salt          faults=1   ILLEGAL / unimplemented
   15     saltu         faults=1   ILLEGAL / unimplemented
   16..48 min max minu maxu sext abs neg moveqz movnez movltz movgez
          addx4 subx8 ssai+src ssa8l+src ssa8b+src ssl+sll ssr+srl
          mull mul16u mul16s muluh mulsh quou quos remu rems
          xsr.intenable pitlb ritlb0 ritlb1 pdtlb rdtlb0           ok
   49     clr_bit_gpio_out   faults=1   ILLEGAL / unimplemented
   50     set_bit_gpio_out   faults=1   ILLEGAL / unimplemented
   51     wr_mask_gpio_out   faults=1   ILLEGAL / unimplemented
   52     rotw +1/-1    ok
   53     movsp         ok
```

Renode's own log named every one of them: `[RAN]`

```
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 4002499d)   salt   a4, a12, a13
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 400249cf)   saltu  a3, a12, a13
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 400250e0)   clr_bit_gpio_out 1
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 40025117)   set_bit_gpio_out 1
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 40025149)   wr_mask_gpio_out a12, a13
```

(PCs mapped to instructions from `firmware/probes/build/r2-rung5-mem.dis`.)

**One fidelity gap in the other direction:** the deliberately unaligned 16-bit load raised **no**
exception. Real ESP32-S2 hardware raises `LoadStoreAlignmentCause` (EXCCAUSE 9). Renode is more
permissive than the silicon, so an alignment bug in firmware would go unnoticed under emulation
rather than being caught. Not a blocker; a teaching-fidelity caveat.

### 3.6 Rung 5b — `rer` · FAIL, hard abort `[RAN]`

`rer` (read external register) does not raise a recoverable exception. tlib aborts:

```
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 400249a1)
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 400249d3)
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 400250e6)
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 4002511d)
[ERROR] cpu: unrecognized opcode in slot 0 (pc = 4002514f)
[ERROR] cpu: CPU abort [PC=0x400251FE]: reading from external register not yet supported.
```

`0x400251FE` is `rer a11, a11`. After that message `emulation RunFor` never returns and the
Renode process must be killed (the captured run exited 124 = timeout). Full log:
`emulator/renode/tests/logs/r2-rung5b-rer.log`.

The matching string `writing to external register not yet supported` is also present in
`renode.exe`, so `wer` behaves the same way. `[SRC]`

`rer` appears 6× in the real image, in `image_load` (second-stage bootloader — skipped anyway),
`ram_set_txcap_reg` (PHY/Wi-Fi), and **`panic_handler` / `esp_panic_handler`**. So it is not on
the happy boot path, but the first time the firmware panics, Renode dies instead of printing a
backtrace — which is exactly when you most need the emulator alive. `[SRC]` + `[INFER]`

---

## 4. Root-causing the missing opcodes

The same rung-5 ELF was run unchanged on five different tlib Xtensa core configurations. `[RAN]`

| `cpuType` | `salt` / `saltu` | `muluh` / `mulsh` | dedicated GPIO |
|---|---|---|---|
| `esp32` | **rejected** | ok | rejected |
| `esp32s2` | **rejected** | ok | rejected |
| `esp32s3` | **rejected** | ok | rejected |
| `dc233c` | rejected | rejected | rejected |
| `de233_fpu` | **ok** | rejected | rejected |

`de233_fpu` executes `salt`/`saltu` correctly. **The translator therefore already implements
them; what is missing is their entry in the `esp32`/`esp32s2`/`esp32s3` core-configuration opcode
tables.** That reframes the fix from "write a translator" to "add opcode entries to a generated
config table".

Corroborating strings inside `renode.exe`: `[SRC]`

```
… rsr.vecbase | wsr.vecbase | xsr.vecbase | salt | saltu | mul16s | mul16u | mull | mul.aa.hh …
… Opcode_salt_Slot_inst_encode | Opcode_saltu_Slot_inst_encode | Opcode_sdcw_Slot_inst_encode …
```

`unrecognized opcode in slot %d` is tlib's Xtensa `disas_xtensa_insn` message, emitted when the
selected core's opcode table has no entry for the encoding; it then raises
`ILLEGAL_INSTRUCTION_CAUSE`, which is precisely the behaviour observed. `[SRC]` + `[INFER]`

Upstream location for a fix: `renode/renode-infrastructure`, `src/Emulator/Cores/tlib`'s Xtensa
target — the generated `xtensa_modules_esp32s2` core-config table (the symbol
`xtensa_modules_esp32s2` is present in `renode.exe`), and for `rer`/`wer` the external-register
path that currently calls the abort. R1 §8.1 already identified the third item in the same file
family (`Xtensa.cs::HandleCompareReached`). `[SRC]`

---

## 5. Coverage — how much of the real firmware did this actually test?

Mnemonics present in the real Sesame S2 image versus mnemonics present in the probe ELFs: `[RAN]`

```
real image distinct mnemonics: 205   total instructions: 135118
probe ELFs distinct mnemonics: 188
in real image but NOT present in any probe: 36
their combined occurrence count: 4705  (3.48% of instructions)
```

**96.5 % of the real firmware's instruction stream, by occurrence, uses mnemonics the probes
executed.** The untested 3.5 % breaks down as:

- **4,577 of the 4,705 are ordinary conditional branches, adds and shifts** - `beqz`, `beq`, `beqi`,
  `add`, `addx8`, `bltz`, `bgeui`, `blti`, `bnone`, `bgez`, `bgei`, `bany`, `l16si`, `sra`,
  `subx2/4`, `jx`, `bbs`, `bnall`. The probes *do* execute `beqz.n`, `bnez.n`, `bne`, `bgeu`,
  `bbci`, `bbsi`, `addx2/4`, `subx8`, `srai`, so these are near-certainly fine. `[INFER]`
- **Genuinely untested, deliberately:** `witlb` (5), `wdtlb` (2), `idtlb` (1) — TLB *writes* were
  skipped because a bad one would remap the probe out from under itself; `waiti` (2) — would
  block forever with no interrupt source; `break` (7) — would trap to the debug vector.
  TLB *reads* (`pitlb`, `pdtlb`, `ritlb0/1`, `rdtlb0`) all passed, which is weak positive
  evidence for the writes.
- **Untested and worth a look in R4:** `callx0` (4), `callx4` (5), `callx12` (2), `retw` non-narrow
  form (79), `rfi` (7), `rfde` (1), `s32nb` (6), `xsr.ibreaka0` (3), `xsr.epc2` (1),
  `wsr.ccount` (1).

Caveat: the 188 figure counts mnemonics as disassembled from the probe ELFs, which includes some
literal-pool bytes decoded as instructions. The *executed* set is a subset; the per-instruction
PASS/FAIL table in §3.5 is the authoritative list of what was actually run. `[INFER]`

---

## 6. Gate A recommendation

> ### Gate A: **YES.** Renode 1.16.1 can execute real ESP32-S2 compiler output.
> **Confidence: high** for everything the ladder covered (windowed ABI, window exceptions,
> `memw`, 41 of 43 special registers, all five memory regions, 49 of 54 instruction probes),
> **medium** for the un-probed 3.5 % listed in §5, and **explicitly unanswered** for everything
> above the CPU line — peripherals, the interrupt matrix, the boot ROM. Those are R4's problem,
> not Gate A's.

R1 retired the fear that Xtensa translation might not reach ESP32 cores. R2 retires the larger
fear behind it: that the core config would be a toy that falls over on real compiler output. It
does not. The windowed ABI — the mechanism that would have been most expensive to fix and would
have killed the approach outright — works completely and provably.

What remains is a **short, named, individually cheap list**, not an open-ended research problem.

### 6.1 Costed list of what is missing, CPU-level only

Estimates are engineering days for someone with the tlib source built. All are `[INFER]`.

| # | Missing | Real-image use | Impact | Fix | Est. |
|---|---|---|---|---|---|
| 1 | **`salt` / `saltu` in the esp32/s2/s3 core configs** | 196× incl. `heap_caps_check_add_region_allowed` (4× `salt`, verified real code starting with `entry a1, 32`), `xTaskIncrementTick`, `prvCheckItemFitsDefault`, `xPortCheckValidListMem`, `esp_psram_init`, `mmu_hal_check_valid_ext_vaddr_region`, `_dtoa_r`, `_vfprintf_r` | **HARD BOOT BLOCKER.** `heap_caps_init()` runs before anything else; the FreeRTOS tick hits it every tick | Add the two opcode entries to the generated `xtensa_modules_esp32{,s2,s3}` tables. The translator already implements them — `de233_fpu` executes them today | **1–2 d** |
| 2 | **`rer` / `wer`** | 6× — `panic_handler`, `esp_panic_handler`, `image_load`, `ram_set_txcap_reg` | Not on the happy path, but turns any firmware panic into a **dead emulator** instead of a diagnosable one | Two options: (a) implement as a stubbed register file; (b) at minimum downgrade the abort to `ILLEGAL_INSTRUCTION_CAUSE` so the guest's own handler runs | **0.5 d** for (b), **2–3 d** for (a) |
| 3 | **Dedicated-GPIO TIE ops** (`set_bit_gpio_out`, `clr_bit_gpio_out`, `wr_mask_gpio_out`) | 8×, several of which look like disassembled data; the credible one is in `esp_cpu_set_watchpoint` | Low. Only reached via the dedicated-GPIO driver, which Sesame does not use | Add opcodes + a trivial semantic writing to a dedicated-GPIO register file | **2–3 d**, deferrable |
| 4 | **CCOMPARE → interrupt map hardcoded to `{6,10,13}`** (R1 §8.1, `Xtensa.cs::HandleCompareReached`, comment says *"this is a mapping for sample_controller"*) | Every FreeRTOS tick | **BLOCKS the FreeRTOS tick.** Not re-measured by R2 — R2 proved the CCOMPARE *registers* work, not the interrupt they raise | Derive the map from the core config, or subclass `Xtensa` in a Renode plugin | **1–2 d** |
| 5 | **`rsr.litbase`, `wsr.mmid`** | 1× each, both in Wi-Fi/PHY blobs or disassembled data | Negligible | Add to the SR table, or leave — the guest's illegal-instruction handler already survives them | **0.25 d**, optional |
| 6 | **Hardware watchpoints (IBREAK/DBREAK effect)** | `esp_cpu_set_watchpoint` | Registers work; only the trap is missing. Affects debugging, not booting | Upstream tlib work | defer |
| 7 | **No unaligned-access exception** | — | Emulator is *more permissive* than silicon; hides firmware bugs | Low priority | defer |

**CPU-level total to unblock a boot attempt: items 1, 2(b) and 4 — roughly 3–5 engineering days.**

Everything else that stands between here and a booting Sesame is *above* the CPU: no boot ROM, no
flash/cache MMU, no interrupt matrix, no TIMG/systimer, no GPIO matrix, no LEDC, no ESP32 I²C, no
SSD1306. R1 §9 already sizes that surface and R4 will cost it against the real ELF. R2's job was
to establish that the CPU underneath is not the problem, and it is not.

### 6.2 Why there is no cheap firmware-side workaround for item 1

Item 1 manifests as a clean `ILLEGAL_INSTRUCTION` exception at `VECBASE+0x340`, which is at least
diagnosable. But `salt`/`saltu` come out of the **prebuilt** `esp32s2-libs 3.3.11` static
libraries (`heap_caps_check_add_region_allowed` is a defined symbol in
`esp32s2-libs/3.3.11/lib/libheap.a(heap_caps_init.c.obj)`, verified with `nm`); the Arduino core ships ESP-IDF as binaries, not source, so there is no
compiler flag we can set on our side that removes them. Rebuilding ESP-IDF from source with a
different core target would break F3's pin and its bit-reproducibility. **Fixing the tlib
core-config table is the only sane route, and it is also the cheapest.** `[INFER]`

---

## 7. Artifacts

| Path | What |
|---|---|
| `firmware/probes/r2/probe.ld` | link layout, addresses sourced from `memory.ld` |
| `firmware/probes/r2/start.S` | startup: window init, `PS`, `VECBASE`, stack, `.bss`, call C |
| `firmware/probes/r2/vectors.S` | six window handlers (byte-identical to Espressif's) + skip-and-continue exception handler |
| `firmware/probes/r2/window_chains.S` | `call4` / `call8` / `call12` recursion chains |
| `firmware/probes/r2/r2_probe.h` | result/fault mailbox layout |
| `firmware/probes/r2/sr_list.h` | the 43 special registers, each with its real-image occurrence count |
| `firmware/probes/r2/rung{1..5}_*.c` | the five rungs |
| `firmware/probes/build-probes.sh` | one command builds every probe ELF |
| `emulator/renode/platforms/esp32s2-sesame.repl` | the platform (see R3 for address provenance) |
| `emulator/renode/scripts/r2-common.resc` + `r2-rung*.resc` | one re-runnable script per rung |
| `emulator/renode/scripts/r2-rung3-trace.resc` | PC trace for the window-vector proof |
| `emulator/renode/tests/run-r2-ladder.mjs` | runs the whole ladder, prints the verdict table |
| `emulator/renode/tests/count-window-vectors.mjs` | counts window-vector entries in the trace |
| `emulator/renode/tests/logs/` | committed raw evidence for every run above |

### Probe ELF manifest `[RAN]`

The full ELF is **not** bit-reproducible: exactly six bytes differ across rebuilds, inside
`.strtab` — the GCC temporary basename used when preprocessing the `.S` inputs, recorded as an
`STT_FILE` symbol. No loadable byte, no instruction and no debug line changes. The
`--strip-all` image hash below **is** bit-identical across rebuilds and is the identity to quote.

| ELF | bytes | image SHA-256 (`--strip-all`, reproducible) |
|---|---:|---|
| `r2-rung1-arith.elf` | 10 528 | `a829f1cd0ba362af1957d9d9a8c505be9b4743d7ce40cc3afb7f30d8c50dbb44` |
| `r2-rung2-call.elf` | 16 264 | `a51d72be1eec719dd9d85142f1bb2bcbda649e5d54ee1d604e0f5675d29415a8` |
| `r2-rung3-window.elf` | 17 080 | `b0b0c5a182e56d5af75e43000097e6112fef9aceba0174b09c4bca0b550b1107` |
| `r2-rung4-sr.elf` | 29 708 | `bd5fd739a04ca9078799538a85f95a295f9fee78c3d9325def64a6e26d978ae9` |
| `r2-rung5-mem.elf` | 26 316 | `e397407ed3b84b7505a5374fa46f2ec39834ab11a1601da37cc03ea9a1a6c534` |
| `r2-rung5b-rer.elf` | 26 560 | `291501bf6f8f3482dd0592ce0d110d0999439d319f5838776ffd4ce1f7de3b03` |
| `r3-uart-hello.elf` | 12 456 | `798985f15a29a2b5ed25823ce59f27afe51169237af9d8c6ef926e7395279793` |

`.repl` / `.resc` hashes are recorded in `reproducibility.json` under `renodePlatformFiles`.

---

## 8. Corrections and additions to earlier findings

1. **R1's prognosis was right, and the answer is favourable.** R1 said Gate A turned on
   instruction and special-register completeness for real compiler output. It does, and the
   answer is yes with a 3–5 day fix list.
2. **New, not in R1: `salt`/`saltu` are missing from all three ESP32 core configs** and are a
   hard boot blocker via `heap_caps_init()` and the FreeRTOS tick.
3. **New: `rer` hard-aborts Renode** rather than raising an exception, so any firmware panic
   kills the emulator.
4. **New: the ESP32-S2 core has no cache instructions and no conditional store**, proved by the
   toolchain itself. Two categories of feared missing Renode functionality are simply not
   applicable, which improves R1 §9's feasibility matrix.
5. **New: Renode does not raise unaligned-access exceptions** on Xtensa — a permissiveness gap,
   not a blocker.
6. **R1's `UART_INT_ST` finding is confirmed and extended** — see R3 §4.
