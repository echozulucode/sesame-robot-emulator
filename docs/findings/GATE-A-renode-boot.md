# Gate A — Renode boot

**Gate question:** *Can Renode execute a target S2/S3 Arduino binary far enough to reach user code?*

**Author:** `gate-reporter` — independent synthesis. This agent performed none of R1–R4; it read
their findings, re-ran what it could, and audited the claims against the evidence cited.
**Date:** 2026-08-23 · **Plan:** `docs/plans/phase-0-foundations-and-renode-research.md` §6

---

## 0. The answer, in the only form that is honest

The gate question has two layers and they have opposite answers. Collapsing them is the single
easiest way to mislead a future reader, so they are kept apart everywhere in this document.

| Layer | Question | Answer | Confidence |
|---|---|---|---|
| **Below the CPU line** | Can Renode's Xtensa core execute what the ESP32-S2 compiler actually emits? | **YES** | **High**, for everything the R2 ladder covered |
| **Above the CPU line** | Can that core, on a Renode platform, carry a real Arduino/ESP-IDF image to user `setup()`? | **NO, today** | **High** — measured, not assumed |

> **Gate A verdict: NO — user code is not reached.**
> Per the plan's decision tree, a NO requires a sized estimate of the missing CPU/SoC work, split
> into *small-enough-to-implement* and *keep-as-research-track*. §4 and §5 give that split.
> The recommendation (§6) is: **implement the small CPU-level items opportunistically; keep the
> SoC work as a research track; do not put Phase 1 on top of it.**

The distinction matters because the two layers failed differently. The CPU layer was *tested to
its limits and passed*. The SoC layer was *never built* — there is nothing above the CPU in
upstream Renode to test.

---

## 1. Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | Verified by running it on this machine — by R1–R4, or re-run by this agent |
| `[SRC]` | Found in a file on this machine, or in an upstream repository read over the GitHub API |
| `[INFER]` | Reasoned, not observed |
| `[DIAG]` | Observed **only** in a machine carrying R4's non-authoritative RAM-backed MMIO shim or hand-installed boot state. Ordering evidence, not ESP32-S2 behaviour evidence |

Re-verified independently by this agent, `[RAN]`:

- `tools/renode/renode.exe --version` → `Renode v1.16.1.19220`, build `d66b0c2a-202602161036`.
- `find tools/renode -iname "*esp*"` → **0 files**. `find "C:/Program Files/Renode" -iname "*esp*"`
  → **0 files**. `-iname "*xtensa*"` → **3 files** in the sidecar. R1 §3 confirmed exactly.
- `sha256sum firmware/artifacts/s2mini/…ino.elf` → `5436d303…9eedfd`, matching F3 and
  `reproducibility.json`. The ELF R2 and R4 measured is the ELF F3 recorded.

---

## 2. Below the CPU line: YES

R2 defined the target empirically rather than from a datasheet: it disassembled the *real* linked
S2 firmware (135,118 instructions, 205 distinct mnemonics) and built a five-rung probe ladder
against what the compiler actually emits, using the same `xtensa-esp32s2-elf-gcc 14.2.0` and the
same codegen flags as F3's build. `[SRC]` `[RAN]`

| Capability | Result | Why it is load-bearing |
|---|---|---|
| Windowed ABI — `entry`, `retw`, `call4/8/12`, `callx8` | **PASS**, 0 exceptions | R1 named this "the single most likely failure point". It is not one |
| All six register-window overflow/underflow handlers | **PASS** — 26/26, 78/78, 35/35 vector entries, counted from a full PC trace; 0 escapes to user/kernel/double vectors | Correct return values alone would not prove the window ever spilled. The trace does |
| `memw` and the sync family (`isync`/`rsync`/`esync`/`dsync`), `rsil` | **PASS**, 0 faults | `memw` guards all 4,157 MMIO accesses in the real image |
| Special registers | **41 of 43 correct** + `threadptr` round-trips. Rejected: `rsr.litbase`, `wsr.mmid` — 1 occurrence each, both in Wi-Fi/PHY blobs or disassembled data, neither on the boot path | FreeRTOS TLS, `PS`, `EPC*`, `EXCSAVE*`, `WINDOWBASE`/`WINDOWSTART`, `CCOUNT`, `CCOMPARE0-2`, `VECBASE` all work |
| Instruction probes | **49 of 54 pass**. Rejected: `salt`, `saltu`, and three dedicated-GPIO TIE ops | See §4 item 4 |
| Memory at real S2 addresses | **PASS** at all five regions (DRAM, IRAM-as-data, RTC fast ×2, RTC slow) | The address map in `esp32s2-sesame.repl` is sourced from Espressif's own headers, not the TRM |
| `rer` | **FAIL — hard emulator abort**, `emulation RunFor` never returns | §4 item 5 |

**Coverage, stated precisely.** R2 reports "96.5 %". That figure is **by instruction occurrence**:
of the real image's 135,118 instructions, 4,705 (3.48 %) use one of 36 mnemonics no probe ELF
contains. By *distinct mnemonic* the coverage is 169/205 = **82.4 %**. R2 also caveats, correctly,
that its 188-mnemonic "probe" set is disassembled from the probe ELFs and therefore includes
literal-pool bytes decoded as instructions — the *executed* set is a subset. **96.5 % is an upper
bound, not a measurement**, and the authoritative list of what actually ran is R2 §3.5's
per-probe PASS/FAIL table. This does not change the verdict; it changes how the number should be
quoted.

**Two feared risks turned out not to exist at all.** `xtensa-esp32s2-elf-as` rejects `s32c1i`,
`SCOMPARE1`, `ATOMCTL` and every Xtensa cache instruction for the S2 core configuration, and the
real 135,118-instruction image contains zero cache instructions. `[RAN]` The S2's cache lives
outside the core, driven over MMIO. So "does Renode implement Xtensa conditional store / cache
control?" is a **non-question for this target**, and two rows come off the risk list before
emulation is even involved.

---

## 3. Above the CPU line: NO

### 3.1 What was measured

R4 loaded (a) a minimal Arduino sketch built by F3's own profile machinery and (b) the real
`s2mini` Sesame ELF onto the checked-in `esp32s2-sesame.repl`.

**Both fail on their very first instruction.** `[RAN]`

```
[INFO]  cpu: Setting PC value to 0x40025738.        # real Sesame ELF entry, call_start_cpu0
[ERROR] cpu: Illegal entry instruction(pc = 40025738)
[ERROR] cpu: CPU abort [PC=0x400003C0]: Trying to execute code outside RAM or ROM at 0x400003C0.
```

The instruction is `entry a1, N`. At architectural Xtensa reset `PS = 0x1F` (`WOE=0`), so tlib
raises `ILLEGAL_INSTRUCTION`; the fault vectors through `VECBASE = 0x40000000`, which is the boot
ROM, which the platform does not contain. On silicon the mask ROM sets `PS`, `SP` and `VECBASE`
before the application entry point ever runs.

> **0 of the 20 steps in `hardware-map.json → bootOrder` are reached, in every configuration
> tried — authoritative or diagnostic. `setup()` is never entered.**

The minimal three-line sketch and the real firmware fail identically, byte for byte. **Nothing
about Sesame is the problem.**

### 3.2 How far it can be pushed, and at what epistemic cost

| Rung | Machine | Retired | Stopped at | Class |
|---|---|---:|---|---|
| A | stock platform | 0 | `0x40025738` — `entry` illegal | **authoritative** |
| B | + hand-installed boot state | 5 | `0x4000FF58` — ROM `esp_rom_get_reset_reason` | **authoritative** |
| C | + real ESP32-S2 mask ROM | 5 M (spinning) | `0x400184BE` — ROM cache-autoload poll | **authoritative** |
| D | + RAM-backed MMIO shim + seeds | 20 M (spinning) | `0x400253BE` — SPI1 command bit never clears | `[DIAG]` |
| E | + real ROM, EXTMEM window only | aborted | `0x400E6AD2` `saltu` → panic → **emulator abort** | `[DIAG]` |

Rung E — the one that walks furthest — reaches **34 ESP-IDF startup functions**, all inside
`call_start_cpu0`'s prologue: cache HAL init, RTC init, MSPI/flash-ID, then `esp_mmu_map_init`.
It never reaches `system_early_init`, `start_cpu0`, FreeRTOS, `app_main`, `loopTask` or `setup()`.

Rung E also produced R4's best methodology observation, worth carrying forward: **a less complete
machine walked further than a more complete one.** With the SPI window unmapped, reads return 0
and the poll exits; with the RAM shim faithfully returning the bit the code just set, it spins
forever. Neither is right. Both are `[DIAG]`.

### 3.3 The ladder Phase 0 planned to walk was the wrong ladder

The plan's R4 description expected *serial → `Wire.begin` → `display.begin()` → Wi-Fi → server →
servo attach*. That ladder is **above** the one that binds. F4's `display.begin()` hard-fail into
`while(1);` at `.ino:662` remains a real future blocker for unmodified firmware, but it is
nowhere near the constraint today: 34 ESP-IDF functions and an entire absent SoC sit below it.

---

## 4. Evidence audit of the sized estimate

The plan requires that a NO come with a sized estimate. R4 produced ≈18–30 d to user code, plus
~10–16 d of peripherals for a robot that moves, with Wi-Fi not costable. **This agent audited
every line item against the evidence R4 cites.** Result: the *ordering* is well evidenced; the
*magnitudes* are uncalibrated engineering judgement; and the headline number does not sum from
its own table.

### 4.1 Critical path to `setup()` — evidence class per item

| # | Item | Evidence cited | Audit | Est. |
|---|---|---|---|---|
| 1 | Boot-ROM machine state (`PS.WOE`, `SP`, window state) | observed PC `0x40025738`, `Illegal entry instruction`, instruction #0 | **Observed, authoritative.** Rung A | 0.25 d |
| 2 | ESP32-S2 mask-ROM image | observed abort at `0x4000FF58`; 126 ROM symbols / 1209 call sites counted from the real ELF | **Observed + counted. DONE** — fetched, checksum-verified against Espressif's published digest, sliced, executes | 0.25 d, delivered |
| 3 | EXTMEM cache controller `0x61800000` | observed spin at ROM `0x400184BE`; five status bits decoded from the ROM disassembly | **Observed, authoritative** (rung C) | 2–3 d |
| 4 | `salt`/`saltu` in the `esp32s2` core config | observed `saltu a2,a10,a8` at `0x400E6AD2` in `s_get_bus_mask`, `cache_ll.h:473`; 196 static uses counted; root cause read from tlib source | **Observed** — but in a `[DIAG]` rung E machine. The *instruction* fault is a CPU fact and R2 reproduced it standalone, so the finding is solid; the *position in the boot* is diagnostic | 1 d + 1–2 d one-off |
| 5 | `rer`/`wer` abort → recoverable | observed `rer a8,a8` at `0x4009BAC2` in `panic_handler` killing the emulator | **Observed.** Reproduced independently by R2 §3.6 on a synthetic probe | 0.5 d |
| 6 | SPI0/SPI1 flash controller + a flash device | spin at `0x40025185`/`0x400253BE`, `bootloader_flash.c:845`; 10 SPI1 registers observed | **`[DIAG]` only.** The spin is a shim artefact (§3.2). That the boot must talk to flash is well supported (`mspi_init` in rung E's authoritative trace) but "blocks boot" here is `[INFER]`, and 5–8 d is the largest single number in the table | 5–8 d |
| 7 | RTCCNTL + clock tree `0x3F408000` | 20 observed addresses; 70 static `l32r` refs | Addresses observed in the `[DIAG]` rung E logging path; static count is real | 3–5 d |
| 8 | SYSTEM clock/reset gating `0x3F4C0000` | 4 observed addresses; 66 static refs; gates every other peripheral | Same class as 7 | 2–3 d |
| 9 | SENSITIVE `0x3F4C1000` | `0x3F4C107C`/`0x3F4C10D8` observed inside ROM `Cache_Allocate_SRAM` | Observed (rung C is authoritative for ROM execution) | 0.5–1 d |
| 10 | EFUSE `0x3F41A000` | `0x3F41A034` observed | Address observed; **"blocks boot (IDF asserts on revision)" is `[INFER]`**, not observed | 0.5–1 d |
| 11 | IRAM/DRAM aliasing | **"not yet hit"** | **No evidence.** R4 says so plainly. Cheap, so the honesty costs nothing | 0.5 d |

**Verdict on the evidence:** 9 of 11 items are anchored to an observed PC or address; item 10's
*blocking* claim and item 11 entirely are inferences, both explicitly labelled as such by R4. No
item is fabricated and no item is silently upgraded. R4's rule of marking shim-bearing runs
`[DIAG]` is applied consistently, which is what makes the audit possible at all.

### 4.2 The arithmetic does not close — flag

R4 §9.1 states "**Subtotal to plausibly reach `setup()`: ≈16–27 d** (items 1, 3–11)", then
"+1–2 d one-off … realistic band **≈18–30 d**".

Summing R4's own line items for 1 and 3–11 gives **15.25–23.25 d**. With the 1–2 d bring-up that
is **≈16–25 d**, not ≈18–30 d. `[RAN]` (arithmetic re-run by this agent)

The gap is in the same direction as prudence — the headline is *more* pessimistic than the
table — so the conclusion is unaffected, and unstated integration overhead on a
register-modelling exercise is defensible. But it should be stated as padding rather than
presented as a sum. **The number to quote is ≈16–25 engineering days by line item, and R4's
≈18–30 d if you want the padded band.** Either way the report's "weeks to months" is retired.

### 4.3 What the estimate is and is not

Every estimate in the table is `[INFER]` — engineering-days judgement by someone who has read
the register maps but has not built a Renode peripheral model on this project. There is no
calibration point: **Phase 0 did not build a single peripheral model**, so nothing in the table
has been checked against an actual delivery. Item 2 is the one exception and it came in at its
estimate (0.25 d), but a download is not a model.

Treat the numbers as an *ordering with magnitudes*, not a schedule.

---

## 5. The split the plan asks for

### 5.1 Small enough to implement — do these opportunistically

These total **~3 d of work plus a 1–2 d one-off build bring-up**, and every one of them is an
upstream contribution that would benefit every future ESP32 user of Renode.

| Item | Fix | Est. | Why it is small |
|---|---|---:|---|
| `rer`/`wer` hard abort | Downgrade the abort to `ILLEGAL_INSTRUCTION_CAUSE` so the guest's own handler runs | 0.5 d | The abort string is one code path. **Do this first in any real effort** — until it is fixed, the emulator dies at the exact moment it becomes interesting |
| `salt`/`saltu` | tlib's `arch/xtensa/core-esp32s2.c` includes **`core-esp32/xtensa-modules.c.inc`** — the *LX6* opcode table — for both LX7 cores. `translate_salt` already exists and is unconditional. The fix is dropping in Espressif's generated LX7 table from `espressif/qemu` `target/xtensa/core-esp32s3/` and changing two `#include` lines | 1 d | A file drop from an official upstream source, not opcode authoring. Verified by R2's rung-5 probe, which already tests these two opcodes explicitly |
| `UART_INT_ST` (0x08) in `ESP32_UART.cs` | The model already computes the interrupt internally via `UpdateInterrupts()`; it simply never exposes the register | ~3 lines / 1 d | Blocks every interrupt-driven serial path |
| CCOMPARE→IRQ map | `Xtensa.cs::HandleCompareReached` hardcodes `{6,10,13}` "for sample_controller"; the S2 is `{6,15,16}` | 0.5 d | Correctness only — see §7 |
| Boot-ROM machine state | Fold `r4-bootstate.resc` into the platform, or model a ROM reset | 0.25 d | Already written and working |
| ESP32-S2 mask ROM | **Already delivered** — `scripts/fetch-esp32s2-rom.mjs` + `esp32s2-rom.repl` | 0 | Espressif publishes it with symbols; it executes |

Gating cost: standing up a tlib + Renode build on this Windows host, **1–2 d, one-off**. Nobody
has done it, and it is the real cost of the first three rows. `[INFER]`

### 5.2 Keep as research track — do not put Phase 1 on this

| Item | Est. | Why it stays research |
|---|---:|---|
| SPI0/SPI1 flash controller + flash device | 5–8 d | Largest single number, and its blocking evidence is `[DIAG]`-only |
| RTCCNTL + clock tree | 3–5 d | 20 registers with behaviour, not storage |
| SYSTEM clock/reset gating | 2–3 d | Gates every other peripheral |
| EXTMEM cache controller | 2–3 d | Five self-completing status bits enumerated; needs behaviour, not a register file |
| SENSITIVE, EFUSE, IRAM/DRAM aliasing | 1.5–2.5 d | Small, but only useful behind the above |
| **Reach `setup()` total** | **≈16–25 d** | §4.2 |
| Interrupt matrix, SYSTIMER, GPIO matrix, LEDC | +10–16 d | Needed for a robot that *moves*, not one that boots |
| ESP32 I²C + SSD1306 device model | +5–8 d | Needed for unmodified firmware past `bootOrder` step 4 |
| **Wi-Fi / PHY / MAC** | **not costable** | `bootOrder` steps 6–15 depend on it. Nobody emulates ESP32 Wi-Fi. Stub the API, never the radio |

---

## 6. Recommendation

> **Do not pursue hybrid firmware emulation as a Phase-1 dependency. Keep Renode as a funded
> research track, and take the ~3 d of CPU-level upstream fixes when someone is in the code
> anyway.**

Reasoning from the evidence, not from caution:

1. **The thing that would have killed the approach outright did not happen.** If the windowed ABI
   or the window-exception machinery had been broken, this would be a multi-month tlib project
   and the answer would be "abandon". It works completely and provably. Renode remains a credible
   long-term ESP32-S2 host.
2. **But nothing above the CPU exists**, and the measured distance to user code is 34 ESP-IDF
   startup functions and ≈16–25 engineering days of register-level modelling — none of it
   research, all of it work.
3. **And `bootOrder` steps 6–15 have no price at any effort level**, because they are Wi-Fi. Even
   a fully successful ≈25-day effort reaches `setup()` and then stops at step 6 unless the Wi-Fi
   API is stubbed at the firmware layer — at which point the firmware is no longer unmodified,
   which was the entire reason for full emulation.
4. **The value Renode was supposed to deliver is already delivered by a cheaper route.** R3 and R7
   proved the UART data plane end to end with a real emulated Xtensa core writing real MMIO, and
   the bridge consumed it with zero changes. Phase 1 gets the emulator's teaching value —
   deterministic virtual time, GDB, snapshots, a real instruction stream — on probe-scale
   programs today, without a booting robot.

### What would change this answer

Any one of these should reopen the gate:

- **Antmicro or a third party lands an ESP32-S2/S3 platform upstream.** R1 checked: the entire
  ESP32 surface across both upstream repos is one file, `ESP32_UART.cs`, and nothing is in flight.
  Waiting is not a strategy, but *watching* is free.
- **A funded 4–6 week embedded slot appears** with nothing on the critical path depending on it.
  The backlog is ordered and the first three items are cheap; the risk is bounded.
- **The teaching requirement changes from "show the real robot" to "show the real firmware
  executing"** — e.g. a lesson that must single-step actual Sesame code. Nothing else in the
  curriculum needs a booting SoC.
- **Espressif publishes a generated S2 LX7 module table** (currently only S3 exists publicly),
  which removes the only over-permissive compromise in the cheap fix list.
- **The `de233_fpu` diagnostic becomes reproducible on a fixed `esp32s2` config.** R4's
  non-authoritative run showed that with `salt`/`saltu` working the boot advances ~25 more
  functions into `esp_clk_init` and, critically, **panic output reaches UART0** via
  `panic_print_char_uart`. Readable IDF panic backtraces on tcp/3456 for ~1.5 d of work would
  change the debugging economics of everything downstream.

---

## 7. Corrections this gate makes to the workstream's own findings

Recorded here rather than by editing another agent's document.

| Claim | Correction | Evidence |
|---|---|---|
| R1 §8.1 / R2 item 4: the hardcoded CCOMPARE map `{6,10,13}` "**BLOCKS the FreeRTOS tick**" | **Downgraded.** `core-isa.h:498-500` gives S2 `XCHAL_TIMER0_INTERRUPT 6`, and `sdkconfig:1698-1700` selects `CONFIG_FREERTOS_CORETIMER_0` with `SYSTICK_USES_CCOUNT`. Renode's `intMap[0]` is 6 — **correct**. Only CCOMPARE1/2 are wrong, and this build never uses them | R4 §6.2 `[SRC]` |
| R2 item 2: `rer` is "not on the happy path… cheap nice-to-have" | **Upgraded to prerequisite.** The first fault the real boot takes reaches `panic_handler` within ~15 instructions and kills the emulator | R4 §4.6 `[RAN]` |
| R2 item 1: `salt`/`saltu` is the **hard boot blocker** | Confirmed as *a* blocker, but the boot dies **three times over** before reaching it: boot state → ROM → EXTMEM → `saltu`. Also cheaper and better root-caused than R2 estimated (§5.1) | R4 §6.1, §7.1 |
| R1 §6: `ESP32_UART`'s register map is "the S2/S3/C3 layout" | **The S2 half is wrong.** Per `uart_reg.h` the S2 has no `CLK_CONF`; `0x74` is `UART_DATE` and `0x78` is `UART_ID`. The model is S3/C3-shaped | R3 §4 `[SRC]` `[RAN]` |
| R2 §5: "96.5 % coverage" | By instruction *occurrence*, and an upper bound. Distinct-mnemonic coverage is 82.4 % | §2 above |
| R4 §9.1: "≈16–27 d subtotal → ≈18–30 d" | Line items sum to 15.25–23.25 d → **≈16–25 d** with the bring-up | §4.2 `[RAN]` |
| R3 §7.5: the no-aliasing simplification "is the one most likely to bite R4" | It did not — the boot dies far earlier. Still a live risk past `system_early_init` | R4 §6.5 |

---

## 8. What this gate does **not** say

- It does **not** say Renode cannot run ESP32 firmware. It says nobody has built the platform, and
  prices building it.
- It does **not** say the CPU is finished. 3.5 % of the real instruction stream by occurrence was
  never executed, and TLB *writes*, `waiti` and `break` were deliberately skipped.
- It does **not** claim the ≈16–25 d band is a schedule. It is an ordered list of register-level
  modelling tasks with uncalibrated day estimates.
- It says **nothing** about whether the *robot* would then behave correctly. Reaching `setup()` is
  the milestone; item 13 (SYSTIMER, backing `millis()`/`delay()`) alone means every movement
  sequence in `hardware-map.movements` needs a further model before a single pose plays.

---

## 9. Reproducing the evidence

```bash
tools/renode/renode.exe --version                                   # 1.16.1.19220
bash firmware/probes/build-probes.sh                                # R2/R3 probe ELFs
node emulator/renode/tests/run-r2-ladder.mjs                        # the five-rung CPU ladder
node emulator/renode/tests/count-window-vectors.mjs                 # window-vector proof
node emulator/renode/tests/r3-uart-capture.mjs                      # UART0 -> socket -> parser
node scripts/fetch-esp32s2-rom.mjs                                  # mask ROM
node emulator/renode/tests/r4-run.mjs \
    emulator/renode/scripts/r4-exp5-sesame-stock.resc r4-exp5-sesame-stock 150   # AUTHORITATIVE
```

**Never invoke `renode.exe` bare on the R4 rung-E scripts** — the `rer` abort wedges
`emulation RunFor` and the process tree must be killed. `r4-run.mjs` does that.

Raw captured logs for every run quoted above are committed under
`emulator/renode/tests/logs/`.
