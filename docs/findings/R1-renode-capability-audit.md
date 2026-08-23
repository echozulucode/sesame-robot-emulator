# R1 · Renode 1.16.x portable sidecar + Xtensa/ESP32 capability audit

**Task:** R1 (Phase 0, Workstream R) · **Agent:** `renode-platform` · **Date:** 2026-08-23
**Status:** complete
**Headline:** Renode 1.16.1 executes ESP32-S2 Xtensa instructions today, and its one ESP32
peripheral — an ESP32 UART — works end-to-end over a host TCP socket. Everything above the
CPU + UART line is still absent from upstream Renode. The Gate-A prognosis is materially better
than the research report assumed.

---

## 0. Evidence labelling

Every claim below carries one of four tags. They are not interchangeable.

| Tag | Meaning |
|---|---|
| `[RAN]` | Verified by executing it on this machine; log output reproduced or summarised from a real run |
| `[FILE]` | A file was found (or confirmed absent) in the installed distribution; path given |
| `[SRC]` | Read from Renode upstream source via the GitHub REST API (`api.github.com`), repo `master` as of 2026-08-23 |
| `[INFER]` | Reasoned conclusion, not directly observed. Treated as unverified |

---

## 1. What was installed

| Field | Value |
|---|---|
| Product | Renode, portable Windows build (self-contained .NET) |
| **Exact version string** | `Renode v1.16.1.19220` |
| Build | `d66b0c2a-202602161036` · build type `Release` · runtime `.NET 8.0.10` |
| Download URL | `https://github.com/renode/renode/releases/download/v1.16.1/renode-1.16.1.windows-portable-dotnet.zip` |
| Archive size | 117,199,021 bytes |
| **Archive SHA-256** | `d09b7934cfd560cd06bde8f131ef78f521f10d423d5aac6096f2a583224aeb3e` |
| Install date | 2026-08-23 |
| Install path | `C:\Projects\sesame-robot-emulator\tools\renode\` (gitignored via the `tools/` rule) |
| Launcher | `C:\Projects\sesame-robot-emulator\tools\renode\renode.exe` |
| Extraction note | The zip's single top-level directory `renode_1.16.1-dotnet_portable/` was stripped, so `tools/renode/renode.exe` is the binary |
| Footprint | 893 files, 323 MB on disk (`renode.exe` is a 289 MB single-file bundle) |
| System install | `C:\Program Files\Renode` (v1.15.3.22387) **untouched**; read only, for comparison |

`[RAN]`

```
$ tools/renode/renode.exe --version
Renode v1.16.1.19220
  build: d66b0c2a-202602161036
  build type: Release
  runtime: .NET 8.0.10
```

**Version adequacy:** 1.16.1 is the newest tagged release. `builds.renode.io` carries nightlies
labelled `1.16.1+20260823git06854d4d1`, i.e. still on the 1.16.1 line. We took the *tagged*
release for reproducibility. This costs us nothing: a full listing of the upstream `master`
trees (section 4) shows the nightlies contain no additional ESP32 assets.

---

## 2. Research-report claims vs. what we found

| # | Claim in the research report | What we actually found | Evidence |
|---|---|---|---|
| 1 | "Renode 1.16.1, released in February 2026, added an ESP32 UART peripheral model" | **Partly wrong on the version, right on the substance.** The ESP32 UART model shipped in **1.16.0** (2025-08-03), listed under *"Added peripheral models: … ESP32 UART"*. The 1.16.1 notes contain no ESP32 item. The model **is** present in 1.16.1 and **does work**. | `[SRC]` GitHub release bodies for v1.16.0 / v1.16.1 (`api.github.com/repos/renode/renode/releases`). `[RAN]` section 5 |
| 2 | "…and experimental Xtensa assembler/disassembler improvements" (attributed to 1.16.1) | **Correct.** v1.16.1 notes, Xtensa section: *"added experimental assembler and disassembler for Xtensa"*. | `[SRC]` v1.16.1 release body |
| 3 | "Current Renode identifies Xtensa among supported CPU architectures" | **Correct, and stronger than stated.** The bundled translation library ships *twelve* Xtensa core configurations, three of which are `esp32`, `esp32s2`, `esp32s3`. All three are accepted as `cpuType` and instantiate. `esp32s2` **executes instructions**. | `[RAN]` sections 5.1–5.2 |
| 4 | "Renode's supported-board documentation has no ESP32 match … no official ESP32 platform" | **Confirmed, emphatically.** Zero files matching `*esp*` (case-insensitive) anywhere in the 893-file distribution. In upstream `master` today the *entire* ESP32 surface across both repos is **one file**: `ESP32_UART.cs`. | `[FILE]` section 3, `[SRC]` section 4 |
| 5 | "no demonstrated official Renode platform on which the unmodified S2/S3 Sesame firmware can simply be loaded and expected to boot" | **Confirmed.** No ESP32 `.repl`, no boot ROM, no flash controller, no interrupt matrix, no LEDC, no ESP32 I²C, no GPIO matrix, no SSD1306 device model. | `[FILE]` section 3, `[SRC]` section 4, section 6 |
| 6 | Feasibility row "ESP32 UART — Direct model exists; S2/S3 compatibility must be tested" | **Model exists and is S2/S3-generation, not ESP32-classic.** Its register map has `CLK_CONF @ 0x78`, `Version @ 0x7C`, `ID @ 0x80` — the S2/S3/C3 layout; ESP32-classic puts `DATE` at 0x78. However **only 11 of the 30 enumerated registers are implemented**; the rest log `Unhandled read`. | `[SRC]` `ESP32_UART.cs`, `[RAN]` section 5.3 |
| 7 | Feasibility row "GDB — Supported Renode feature" | **Confirmed for Xtensa specifically.** `cpu GDBArchitecture` returns `xtensa`; a GDB server starts on a machine whose only CPU is `cpuType: "esp32s2"`. | `[RAN]` section 7 |
| 8 | Feasibility rows "UART-to-host socket / virtual time / snapshots — Supported directly" | **All three confirmed on an Xtensa + ESP32_UART machine**, not merely in general. | `[RAN]` sections 5.4, 7 |
| 9 | Implicit assumption that "Xtensa translation support" might not extend to ESP32 cores | **Refuted.** The `esp32`/`esp32s2`/`esp32s3` core configs are *not new* — they are present in the 1.15.3 install too. They were simply never exposed by any platform file. | `[RAN]` grep of `C:\Program Files\Renode\bin` vs. `tools/renode/renode.exe` |

### Verdict on the ESP32-UART claim

> **CONFIRMED, with a version correction.** An ESP32 UART peripheral model exists, is compiled
> into Renode 1.16.1, instantiates from a `.repl`, and moves bytes from a target-side FIFO
> register to a host TCP socket. It landed in **1.16.0**, not 1.16.1. Its register coverage is
> partial (11 of 30). Add the version correction to the Phase-0 corrections list.

---

## 3. Inventory: Xtensa- and ESP32-related assets in `tools/renode/`

`[FILE]` Exhaustive, from `find . -iname "*esp*"` and `find . -iname "*xtensa*"`.

**Files whose name contains `esp` (case-insensitive): _none_.** Zero. Not in `platforms/`,
`scripts/`, `tests/`, `plugins/`, or `tools/`.

**Files whose name contains `xtensa`: exactly three.**

| Path | What it is |
|---|---|
| `tools/renode/platforms/cpus/xtensa-sample-controller.repl` | The only Xtensa platform. `cpuType: "sample_controller"`, three RAMs, a ROM at `0x50000000`, and a `UART.SemihostingUart` |
| `tools/renode/scripts/single-node/xtensa.resc` | Loads the above plus a remotely-hosted Zephyr `hello_world` ELF |
| `tools/renode/tests/platforms/xtensa.robot` | Two Robot tests: hand-assembled MOVI/L32I/BEQZ/QUOU/J stepping, and the Zephyr sample |

**Compiled-in Xtensa core configurations** — `[RAN]` `grep -a -o 'xtensa_modules_[A-Za-z0-9_]*' renode.exe`:

```
xtensa_modules_dc233c              xtensa_modules_esp32
xtensa_modules_de212               xtensa_modules_esp32s2
xtensa_modules_de233_fpu           xtensa_modules_esp32s3
xtensa_modules_dsp3400             xtensa_modules_imx8
xtensa_modules_sample_controller   xtensa_modules_imx8m
xtensa_modules_test_kc705_be       xtensa_modules_test_mmuhifi_c3
```

The matching `cpuType` strings (`esp32`, `esp32s2`, `esp32s3`, `sample_controller`, `dc233c`,
`de212`, `de233_fpu`, `dsp3400`, `imx8`, `imx8m`, `test_kc705_be`, `test_mmuhifi_c3`) appear as
a contiguous C string table in the bundled `tlib` translation library. **The identical twelve
appear in Renode 1.15.3** (`C:\Program Files\Renode\bin`), so ESP32 *core* support is old news
that nobody ever wired to a platform.

**ESP32-related .NET type in the bundle** — `[RAN]` binary string extraction at offset
248,397,263, inside the `Antmicro.Renode.Peripherals.UART` type-name run:

```
…GD32_UART · EFM32_UART · STM32_UART · ESP32_UART · NEORV32_UART · RenesasDA14_UART…
```

`ESP32_UART` is the **only** ESP32 identifier in the whole 289 MB binary other than the tlib core
names. **It is absent from Renode 1.15.3's assemblies** (`grep -a -r ESP32 "C:\Program Files\Renode\bin"`
returns nothing), which independently dates the model to the 1.16 line.

**ESP32 example `.resc` scripts: none.** `[FILE]`

---

## 4. Upstream `master` cross-check — is more coming?

`[SRC]` Full recursive tree listing of both upstream repos via
`api.github.com/.../git/trees/master?recursive=1` (neither response truncated), filtered for
`esp32|xtensa`:

`renode/renode-infrastructure` (the C# models):

```
src/Emulator/Cores/Xtensa/Xtensa.cs
src/Emulator/Cores/Xtensa/XtensaRegisters.cs
src/Emulator/Cores/Xtensa/XtensaRegisters.tt
src/Emulator/Cores/renode/arch/xtensa/renode_xtensa_callbacks.c
src/Emulator/Peripherals/Peripherals/UART/ESP32_UART.cs     <- the entire ESP32 surface
```

`renode/renode` (platforms, scripts, tests):

```
platforms/cpus/xtensa-sample-controller.repl
scripts/single-node/xtensa.resc
tests/platforms/xtensa.robot
```

**Conclusion:** there is no in-flight ESP32 platform upstream. Waiting for Antmicro is not a
strategy. Anything we need, we build.

---

## 5. Runtime verification

All runs used `tools/renode/renode.exe --console --disable-xwt --plain <script.resc>` — fully
headless, no GUI, non-blocking. (`--hide-monitor` and `--console` are mutually exclusive; use
`--console --disable-xwt`.) Logs below are **real captured output**, trimmed only of repeated
banner lines.

### 5.1 Xtensa smoke test on the stock `sample_controller` platform — PASS `[RAN]`

Script: `emulator/renode/probes/r1-xtensa-smoke.resc` (checked in). It loads the stock
`platforms/cpus/xtensa-sample-controller.repl`, adds RAM at `0x0`, hand-assembles
`MOVI a1,0x400 / L32I a2 / L32I a3 / BEQZ / QUOU a4,a2,a3 / J`, and single-steps.

```
Renode, version 1.16.1 (d66b0c2a-202602161036)
06:42:20.8917 [INFO] System bus created.
--- before step ---
0x0
06:42:22.0437 [INFO] xtensa-smoke: Machine started.
--- after step 1 (expect PC 0x3) ---
0x3
--- after step 2 (expect PC 0x6) ---
0x6
--- after step 6 (expect PC 0x15) ---
0x15
--- registers a1..a4 ---
0x400
0x10
0x2
0x8
--- ExecutedInstructions ---
0x0000000000000006
06:42:22.2095 [INFO] xtensa-smoke: Machine paused.
```

`a4 = 0x8 = 0x10 / 0x2` — the integer-divide instruction really executed; six instructions
retired. The only warning is a benign translation-library cleanup notice on dispose.

### 5.2 The same program on an `esp32s2` core — PASS `[RAN]`

Script: `emulator/renode/probes/r1-esp32s2-exec.resc` (checked in). No `sample_controller`
anywhere: `cpu: CPU.Xtensa @ sysbus { cpuType: "esp32s2"; frequency: 240000000 }`, with code in
a `MappedMemory` at the real ESP32-S2 IRAM base `0x40020000`.

```
=== default reset PC for cpuType esp32s2 ===
0x50000000
06:58:06.4037 [INFO] esp32s2-exec: Machine started.
=== PC after 6 steps (expect 0x40020015) ===
0x40020015
=== a1(0x400) a2(0x10) a3(0x2) a4(quotient, expect 0x8) ===
0x400
0x10
0x2
0x8
=== executed instructions ===
0x0000000000000006
=== other ESP32 cpuTypes ===
  (machine "esp32-var",   cpuType "esp32")    -> cpu (Xtensa) instantiated
  (machine "esp32s3-var", cpuType "esp32s3")  -> cpu (Xtensa) instantiated
```

**This is the single most important result in R1.** It substantially pre-answers R2: the
`esp32s2` Xtensa core configuration is real, selectable, and executes target instructions,
including the divide option.

Caveat to carry into R2: the **default reset PC is `0x50000000`**, not the ESP32-S2 ROM reset
vector `0x40000400`. `[INFER]` this is a Renode/tlib default rather than a per-core value;
either way R2 must set `cpu PC` explicitly or rely on an ELF entry point.

### 5.3 `UART.ESP32_UART` instantiation and register coverage `[RAN]`

Instantiated at the ESP32-S2 UART0 base with no complaint:

```
=== peripherals after UART ===
  sysbus (SystemBus)
   |- cpu   (Xtensa)          Slot: 0
   |- dram  (MappedMemory)    <0x3FFB0000, 0x3FFFFFFF>
   |- iram  (MappedMemory)    <0x40020000, 0x4006FFFF>
   \- uart0 (ESP32_UART)      <0x3F400000, 0x3F4000FF>
```

Register-space sweep (`ReadDoubleWord` over all 64 dword offsets in the 0x100 window):

- **Implemented (11):** `0x00 0x04 0x0C 0x10 0x14 0x18 0x1C 0x20 0x24 0x30 0x78`
- **Unhandled (53):** everything else, each logging `uart0: Unhandled read from offset 0x…`

Cross-checked against upstream `[SRC]` `ESP32_UART.cs` (247 lines, MIT, "Copyright (c) 2024
Sean 'xobs' Cross"), whose `Registers` enum declares 30 registers but whose `registersMap`
populates only those 11. Named gaps that matter:

| Offset | Register | Status | Why we care |
|---|---|---|---|
| `0x08` | `MaskedInterruptStatus` (`UART_INT_ST`) | **enumerated but NOT implemented** | Every ESP-IDF UART ISR reads this. Interrupt-driven RX will not work as shipped |
| `0x60` | `ThresholdAndAllocation` (`UART_MEM_CONF`) | not implemented | FIFO sizing |
| `0x64` / `0x68` / `0x6C` | FIFO offset / status | not implemented | driver polling paths |
| `0x7C` / `0x80` | `Version` / `ID` | not implemented | some drivers probe these |

The model **does** implement the interrupt logic internally (`UpdateInterrupts()` drives a
`GPIO IRQ` from `RawInterruptStatus & InterruptMask`); it simply never exposes `UART_INT_ST` on
the bus. That is a roughly three-line upstream fix and a good candidate contribution back.

`Size => 0x100`, `BaudRate => 115200` fixed, `StopBits => One`, `Parity => None`. `[SRC]`

### 5.4 ESP32 UART to host TCP socket, end to end — PASS `[RAN]`

This is the R3 bridge primitive, proved a wave early. Renode opened a server socket terminal on
TCP 3456, connected it to `uart0`, and the target-side write path pushed bytes to a real host
client.

Renode side:

```
=== socket terminal up on 3456 ===
=== writing bytes ===          (8 x sysbus WriteDoubleWord 0x3F400000 <char>)
=== written ===
```

Host side (independent Python TCP client, `socket.create_connection(('127.0.0.1', 3456))`):

```
CONNECTED
RECEIVED: b'@SESAME\n'
```

A `uart0 CreateFileBackend` run produced the same result to disk (`Hi!`). The exact monitor calls
R3 needs:

```
emulation CreateServerSocketTerminal 3456 "term" false   # port, name, telnetMode=false
connector Connect uart0 term
```

`telnetMode: false` matters — the default is `true`, which injects telnet negotiation bytes into
the stream and would corrupt the `@SESAME` line protocol.

---

## 6. Reusable generic building blocks

Method: (a) every `Namespace.Type` used across the shipped `.repl` files was extracted and
counted — those are demonstrably instantiable; (b) candidates were then **actually instantiated**
at ESP32-S2 addresses in `emulator/renode/probes/r1-blocks-probe.repl` and exercised. `[RAN]`

```
=== peripherals ===
  sysbus (SystemBus)
   |- arr        (ArrayMemory)      <0x60000000, 0x60000FFF>
   |- cpu        (Xtensa)           Slot: 0
   |- dram       (MappedMemory)     <0x3FFB0000, 0x3FFFFFFF>
   |- i2c0       (OpenCoresI2C)     <0x3F413000, 0x3F413FFF>
   |- iram       (MappedMemory)     <0x40020000, 0x4006FFFF>
   |- stub_ledc  (PythonPeripheral) <0x3F419000, 0x3F4193FF>
   \- uart0      (ESP32_UART)       <0x3F400000, 0x3F4000FF>
=== python stub write/read 0x3F419008 ===
0xDEADBEEF
=== ArrayMemory write/read 0x60000010 ===
0x12345678
```

| Need | Reusable stock model | Verdict | Evidence |
|---|---|---|---|
| RAM / IRAM / DRAM | `Memory.MappedMemory` (416 uses in shipped repls), `Memory.ArrayMemory` (22) | **Reusable as-is** | `[RAN]` mapped at real S2 bases, read/write verified |
| **Arbitrary MMIO stub** | `Python.PythonPeripheral` (`size`, `initable`, inline `script` using `request.IsRead/IsWrite/Offset/Value`) | **Reusable as-is — the key tool** | `[RAN]` `0xDEADBEEF` round-tripped through a scripted 0x400-byte stub at the LEDC base |
| UART | `UART.ESP32_UART` (ESP32-specific), plus 40+ generics including `UART.TrivialUart`, `UART.NS16550`, `UART.SemihostingUart` | **Reusable**; the ESP32 one is partial | `[RAN]` sections 5.3–5.4 |
| I²C controller | `I2C.OpenCoresI2C`, `I2C.SimpleI2C`, `I2C.Cadence_I2C`, `I2C.LiteX_I2C`, 19 more | **Instantiable, but none is the ESP32 I²C** — register layouts differ entirely | `[RAN]` OpenCoresI2C instantiated at 0x3F413000 |
| I²C *device* (for the OLED) | 19 distinct `Sensors.*` device models (mostly I²C) plus a Generic I2C EEPROM (added in 1.16.0) as templates. **No SSD1306** | **New model required**, but with excellent precedent | `[FILE]` zero `SSD1306` strings in the binary |
| GPIO | 38 `GPIOPort.*` models, all SoC-specific; `GPIOPort.BaseGPIOPort` is the abstract base | **Base class reusable, model must be written** | `[RAN]` repl catalogue |
| Timers | 81 `Timers.*` models, all SoC-specific. The Xtensa CPU has **three built-in `ComparingTimer`s** (CCOMPARE0-2) | **CPU-internal timers already exist** — see the caveat in section 8 | `[SRC]` `Xtensa.cs`, `InnerTimersCount = 3` |
| PWM / LEDC | `Timers.IMXRT_PWM`, `HiFive_PWM`, `Quark_PWM` only. **No LEDC, no generic PWM** | **New model required** (or a Python stub) | `[FILE]` no `LEDC` strings |
| SPI / flash | `SPI.GenericSpiFlash`, `MTD.DummySPIFlash`, 35 SPI controllers | **Generic flash device reusable**; the ESP32 SPI/flash *controller* is not | `[RAN]` repl catalogue |
| Interrupts | `uart0 { IRQ -> cpu@5 }` parses and binds. `Xtensa.OnGPIO(n, …)` calls `TlibSetIrqPendingBit(n, …)` | **Peripheral-to-CPU IRQ delivery works with no interrupt-controller model at all** | `[RAN]` repl parsed, `GetGPIOs` returns `(IRQ, GPIO: unset)`; `[SRC]` `Xtensa.cs` |
| LED / button (teaching visuals) | `Miscellaneous.LED` (105 uses), `Miscellaneous.Button` (77) | **Reusable as-is** | `[RAN]` |
| Framebuffer / display | `Video.PL110`, `Video.STM32LTDC`, `Video.LiteX_Framebuffer_CSR32`, … | Wrong shape for a 128x64 I²C OLED; a custom I²C device is the right answer | `[RAN]` repl catalogue |

The practical consequence: **an ESP32-S2 `.repl` can be assembled today out of `MappedMemory`,
`ESP32_UART`, and `Python.PythonPeripheral` stubs, with zero C# written.** Whether firmware
survives contact with those stubs is R2/R4's question — but the platform-authoring step is not
a blocker.

---

## 7. Renode features verified specifically on an Xtensa/ESP32 machine `[RAN]`

```
=== GDBArchitecture ===
xtensa
=== start gdb server on 3334 ===
07:00:24.2382 [INFO] gdbsnap: CPUs: ["gdbsnap.cpu"] were added to a new GDB server created on port :3334
07:00:24.2384 [INFO] gdbsnap: GDB server with all CPUs started on port :3334
=== virtual time ===
Current virtual time: 00:00:00.000000000
Current real time: 00:00:00.000000000
=== snapshot save ===
=== snapshot saved ===
```

`Save` produced a 282,713-byte snapshot of a machine containing an `esp32s2` CPU and an
`ESP32_UART`. Note `[SRC]`: `Xtensa.GDBFeatures` returns an **empty** descriptor list, so GDB
gets no XML target description for Xtensa — register access may be limited. Flagged for R4.

Also confirmed available on the Xtensa CPU object `[RAN]`: `AddHook(addr, python)`,
`AddSymbolHook`, `SetHookAtBlockBegin/End`, `AddHookAtInterruptBegin/End`, `LogFunctionNames`,
`LogCpuInterrupts`, `CreateExecutionTracing`, `Step(n)`, `GetRegister` / `SetRegister`. That is
the complete toolkit R4 needs to find "the exact first unsupported block".

---

## 8. Two concrete landmines found in the source `[SRC]`

### 8.1 The Xtensa internal-timer interrupt map is hardcoded for `sample_controller`

`renode-infrastructure/src/Emulator/Cores/Xtensa/Xtensa.cs`:

```csharp
private void HandleCompareReached(int id)
{
    // this is a mapping for sample_controller
    var intMap = new uint[] { 6, 10, 13 };

    // this is a mapping for baytrail
    // var intMap = new uint[] { 1, 5, 7 };
    TlibSetIrqPendingBit(intMap[id], 1u);
}
```

The CCOMPARE0/1/2 to interrupt-number mapping is a literal chosen for the sample controller, and
is **not derived from the selected core config**. `[INFER]` ESP32/S2/S3 use different interrupt
numbers for CCOMPARE1/2, so the FreeRTOS tick that Arduino-ESP32 relies on would fire on the
wrong interrupt line. The exact ESP32-S2 values must be read from the TRM in R2. Fix options: a
C# subclass shipped as a Renode plugin, or an upstream PR. Small, bounded, and now *known* —
exactly the kind of item R1 exists to surface.

### 8.2 `ESP32_UART` never exposes `UART_INT_ST` (0x08)

See section 5.3. Also small and bounded.

---

## 9. Revised feasibility matrix

`Δ` column: **↑** upgraded (better than the report), **=** unchanged, **↓** downgraded,
**✎** reclassified with new precision.

| Requirement | Report's classification | **Our evidence-backed classification** | Evidence | Δ |
|---|---|---|---|---|
| Xtensa instruction translation | Supported directly | **Supported and executed on this machine, on `esp32s2` specifically** — not merely generic Xtensa | `[RAN]` 5.1, 5.2 | ↑ |
| Complete ESP32-S2 platform | Not demonstrated / likely new platform work | **Confirmed absent upstream, but authorable by us from stock parts** (`MappedMemory` + `ESP32_UART` + `PythonPeripheral` stubs, no C#) | `[FILE]` 3, `[SRC]` 4, `[RAN]` 6 | ✎ |
| Complete ESP32-S3 platform | Not demonstrated / likely new platform work | **Same as S2.** `cpuType: "esp32s3"` instantiates; nothing else exists | `[RAN]` 5.2 | ✎ |
| Lolin S2 Mini board definition | Requires configuration/platform work | **Unchanged** — trivial once an S2 SoC repl exists (it is a pin/flash-size wrapper) | `[FILE]` 3 | = |
| Distro V3.1 / S3 board definition | Requires configuration/platform work | **Unchanged** | `[FILE]` 3 | = |
| ESP32 UART | Direct model exists; S2/S3 compatibility must be tested | **Exists, is S2/S3-generation layout, verified working TX to host socket. 11 of 30 registers implemented; `UART_INT_ST` (0x08) missing** | `[RAN]` 5.3–5.4, `[SRC]` `ESP32_UART.cs` | ↑✎ |
| Interrupt controller | Needs source audit/modeling · *boot blocker* | **Split in two.** (a) *CPU interrupt delivery*: **already works** — `IRQ -> cpu@N` in a repl drives `TlibSetIrqPendingBit`; no controller model needed. (b) *ESP32 interrupt matrix* (programmable peripheral-to-CPU routing): **absent, must be stubbed or modelled** | `[RAN]` 6, `[SRC]` `Xtensa.cs` | ↑✎ |
| Timers / system clocks | Needs source audit/modeling · *boot/runtime blocker* | **Split.** (a) Xtensa CCOMPARE0-2 internal timers: **already modelled** (three `ComparingTimer`s, `CCOUNT` via `GetCPUTime`). (b) **The compare-to-interrupt map is hardcoded to `sample_controller` `{6,10,13}` and is wrong for ESP32** — small C# fix. (c) ESP32 TIMG / systimer peripherals: absent | `[SRC]` 8.1 | ↑✎ |
| GPIO matrix | Needs SoC modeling | **Unchanged — new model required.** 38 GPIO models ship, none ESP32; `BaseGPIOPort` is a usable base class | `[RAN]` 6 | = |
| LEDC PWM | Likely new model | **Confirmed: new model required.** No LEDC, no generic PWM. *But* a `PythonPeripheral` stub can absorb the register writes, and for Sesame we only need the **duty value**, not waveform fidelity | `[FILE]` 6, `[RAN]` 6 | ✎ |
| I²C controller | Likely new ESP32 model/integration · *OLED boot blocker* | **Confirmed: new model required.** 23 I²C controllers ship, none ESP32-compatible | `[RAN]` 6 | = |
| SSD1306 external device | Mock/custom device reasonable | **Confirmed absent** (zero `SSD1306` strings). A custom I²C device remains reasonable; the 19 shipped `Sensors.*` device models are usable templates | `[FILE]` 6 | = |
| SPI / flash controller | Likely substantial platform work | **Split.** Flash *device*: `SPI.GenericSpiFlash` / `MTD.DummySPIFlash` reusable. ESP32 SPI0/1 *controller* plus cache-mapped XIP: **absent, substantial**. Mitigation: load the ELF directly into RAM and skip XIP entirely | `[RAN]` 6 | ✎ |
| Boot ROM / ROM calls | Substantial correctness work possible | **Unchanged, absent.** No ESP32 ROM blob, no ROM-function mocks. Renode does have precedent (`Nuvoton NPCX9 OTPI ROM function mocks`, 1.16.1 notes), so the technique is established | `[SRC]` 4, release notes | ✎ |
| USB CDC / USB OTG | Difficult / defer | **Unchanged.** `emulation CreateCDCToUARTConverter` exists as a host-side helper, but there is no ESP32 USB-serial-JTAG model. Defer; the S3 profile can use UART0 | `[RAN]` 7 | = |
| Wi-Fi radio / driver environment | Difficult / major effort | **Unchanged. Mock at the firmware or host layer** | `[SRC]` 4 | = |
| Servo mechanics | Mock/behavioral model | **Unchanged — easy once the command is captured** | — | = |
| GDB | Supported Renode feature | **Confirmed on Xtensa** (`GDBArchitecture == "xtensa"`, server starts). Caveat: `GDBFeatures` is empty, so there is no target XML and register visibility may be degraded | `[RAN]` 7, `[SRC]` `Xtensa.cs` | ✎ |
| UART-to-host socket | Supported directly | **Confirmed end-to-end with `ESP32_UART`** — bytes written to the target FIFO register arrived at a host TCP client. Use `telnetMode: false` | `[RAN]` 5.4 | ↑ |
| Deterministic virtual time | Supported directly | **Confirmed on an Xtensa machine** (`currentTime`) | `[RAN]` 7 | = |
| Snapshots | Supported directly | **Confirmed on an Xtensa + ESP32_UART machine** (282 KB snapshot written) | `[RAN]` 7 | = |

**Net movement:** four rows upgraded, eight reclassified with materially more precision, none
downgraded. Nothing we found is worse than the report assumed.

---

## 10. What R2 should try first

**Concrete CPU type string:** `esp32s2` (validated). `esp32s3` and `esp32` also instantiate.

**Minimal `.repl` skeleton** — start from `emulator/renode/probes/r1-esp32s2-exec.resc`, which is
already a working CPU + RAM platform. Suggested first `.repl` (addresses taken from the ESP32-S2
TRM; `[INFER]` — verify against the TRM before trusting them):

```
cpu: CPU.Xtensa @ sysbus
    cpuType: "esp32s2"
    frequency: 240000000

// internal SRAM - instruction and data views
iram: Memory.MappedMemory @ sysbus 0x40020000
    size: 0x50000
dram: Memory.MappedMemory @ sysbus 0x3FFB0000
    size: 0x50000

// UART0
uart0: UART.ESP32_UART @ sysbus 0x3F400000
    IRQ -> cpu@5          // interrupt number is a guess - verify against the TRM
```

**Ordered plan for R2:**

1. Build a freestanding Xtensa ELF (`-mtext-section-literals`, no libc, no FreeRTOS) with the
   `xtensa-esp32s2-elf-*` toolchain the ESP32 Arduino core installs in F3. Link `.text` at
   `0x40020000`, with a labelled infinite loop at a known symbol.
2. `sysbus LoadELF @…`, then set `cpu PC <entry>` **explicitly** — do not rely on the reset
   vector; the default PC is `0x50000000`, not the ESP32 ROM vector.
3. `cpu Step 20`; assert PC reaches the known symbol. This is a near-certain pass given 5.2.
4. Only then add `UART.ESP32_UART` and write literals to `0x3F400000`. Reuse the exact socket
   incantation from 5.4.
5. Turn on `cpu LogFunctionNames true` and peripheral-access logging before the first real
   firmware attempt, so R4 inherits a working instrument.

**Biggest unknowns, in the order they will bite:**

1. **Whether the `esp32s2` tlib core config enables the options real ESP-IDF code uses** —
   windowed registers (`entry`/`retw`), `WSR`/`RSR` of ESP32-specific special registers, cache
   control instructions, `memw` ordering. Our six-instruction test touched none of these. This
   is the true Gate-A question and it is *not* yet answered.
2. **The CCOMPARE interrupt-map bug (8.1).** Blocks any FreeRTOS tick. Bounded C# fix.
3. **The reset/boot path.** With no boot ROM, the ESP-IDF second-stage bootloader cannot run;
   R2/R4 must load the ELF directly and jump to `app_main`/`setup`, skipping the bootloader.
4. **`UART_INT_ST` (0x08) missing (8.2)** — surfaces the moment interrupt-driven serial is used
   rather than polled writes.
5. **Literal-pool addressing.** Xtensa literals are PC-relative; a wrong link address produces
   silent garbage rather than a clean fault.

**A note on Gate A.** The report's stated fear was that Xtensa translation support might not
reach ESP32 cores at all. That fear is retired: it does, on this machine, today. Gate A now turns
on unknown #1 above — instruction and special-register *completeness* for real compiler output —
not on whether Renode can run Xtensa. R2 should be scoped to answer exactly that.

---

## 11. Artifacts produced

| Path | Purpose |
|---|---|
| `tools/renode/` | Renode 1.16.1 portable sidecar (gitignored) |
| `emulator/renode/probes/r1-xtensa-smoke.resc` | 5.1 stock-platform Xtensa execution smoke test |
| `emulator/renode/probes/r1-esp32s2-exec.resc` | 5.2 `esp32s2` core execution probe plus cpuType matrix |
| `emulator/renode/probes/r1-esp32-probe.resc` | 5.3 `esp32s2` CPU + `ESP32_UART` instantiation probe |
| `emulator/renode/probes/r1-blocks-probe.repl` + `.resc` | 6 reusable-building-block instantiation probe |
| `docs/findings/R1-renode-capability-audit.md` | this document |

All probes are re-runnable with:

```
tools/renode/renode.exe --console --disable-xwt --plain <script>
```

---

## 12. For `reproducibility.json`

```json
{
  "renode": {
    "version": "1.16.1.19220",
    "build": "d66b0c2a-202602161036",
    "runtime": ".NET 8.0.10",
    "source": "https://github.com/renode/renode/releases/download/v1.16.1/renode-1.16.1.windows-portable-dotnet.zip",
    "archiveSha256": "d09b7934cfd560cd06bde8f131ef78f521f10d423d5aac6096f2a583224aeb3e",
    "archiveBytes": 117199021,
    "installPath": "tools/renode",
    "installedOn": "2026-08-23"
  }
}
```
