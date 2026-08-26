# Deep research prompt — Why Renode did not fit, and whether we were wrong

**Purpose:** an external-research brief. Copy the section between the rules into a deep-research
tool. Everything in it is a finding *we* produced on one Windows 11 machine between 2026-08-23 and
2026-08-25; treat all of it as a claim to be checked, not as background.

**What we want out of it:** disconfirmation as much as confirmation. We made an expensive
architectural call — abandoning Renode for Espressif's QEMU fork — on roughly two days of
evidence. If that call was wrong, or right for the wrong reasons, we would rather know now.

---

## Context

I am building an educational platform around the **Sesame robot**, an open-source ESP32 quadruped
(8× MG90S servos, SSD1306 OLED, Arduino-ESP32 firmware). I wanted a **firmware emulator** — real
compiled firmware executing against emulated peripherals — so learners can watch actual code drive
a virtual robot, rather than a behavioural model that merely imitates it.

I evaluated **Renode 1.16.1** first, then **Espressif's QEMU fork** (`esp-develop-9.2.2-20260417`),
and switched to QEMU. I want to know whether that was the right call, what I misjudged, and what
the wider ESP32-emulation landscape actually looks like.

**Hard constraint: I will never have physical hardware.** No robot, no bare ESP32 board, no logic
analyser. Anything that can only be settled on silicon is permanently out of reach, so emulator
fidelity carries more weight for me than for a typical embedded project.

Target boards: **ESP32-S2** (Lolin S2 Mini, the recommended DIY build), **ESP32-S3** (current Distro
board), and the original **ESP32** (legacy Distro V1, still supported).

## What I measured

**Renode 1.16.1 (portable, Windows):**

1. The **Xtensa CPU works**. Freestanding ELFs from the real `xtensa-esp32s2-elf-gcc` 14.2.0
   executed correctly: windowed ABI (`entry`/`retw`/`call8`/`callx8`), register-window
   overflow/underflow (traced 4×26, 8×78, 12×35, perfectly balanced, nothing escaping to the
   double-exception vector), `memw`, 41/43 special registers, 49/54 opcode probes. 96.5% of the
   real firmware image's 135,118 instructions use mnemonics I executed.
2. **There is no ESP32 SoC platform.** A full recursive listing of both Renode repositories'
   `master` returned exactly one ESP32 file: `ESP32_UART.cs`. No `.repl`, no board, nothing else.
3. **Consequence: 0 of 20 boot steps.** Both the real firmware and a three-line Arduino sketch
   abort on **instruction #0** — `entry` is illegal because reset state is `PS 0x1F` (WOE=0),
   `WINDOWSTART 0`, `SP 0`, and with no boot ROM nothing initialises them. I later loaded
   Espressif's official mask-ROM ELF, after which real ROM code ran and the wall moved to
   cache/flash controllers.
4. **`salt`/`saltu` are unrecognised on the ESP32 core configs.** 196 uses in the real image
   (including `heap_caps_check_add_region_allowed` and `xTaskIncrementTick`). Root cause found in
   source: `tlib/arch/xtensa/core-esp32s2.c` and `core-esp32s3.c` literally
   `#include "core-esp32/xtensa-modules.c.inc"` — **the LX6 opcode table on LX7 cores**.
   `translate_salt` already exists in `translate.c`. The same binary runs those instructions fine
   on `cpuType: de233_fpu`.
5. **`rer` aborts the emulator unrecoverably** — `RunFor` never returns, the process must be
   killed. Six uses, including `esp_panic_handler`, so the first firmware panic destroys the
   emulator.
6. `Xtensa.cs::HandleCompareReached` hardcodes the CCOMPARE→interrupt map to `{6,10,13}` with the
   comment *"this is a mapping for sample_controller"*.
7. My costed estimate to reach user code: **≈16–25 engineering days**, then ~20 more for
   peripherals, with **Wi-Fi uncostable at any price**.

**Espressif's QEMU fork, same firmware, same day:**

8. Boots the real ROM, real bootloader, ESP-IDF and FreeRTOS, and **enters `setup()`**. Reaches
   7/20 boot steps stock; with Wi-Fi elided, all 20, emitting real telemetry.
9. Blocker is `assert failed: esp_phy_enable phy_init.c:336` — **no Wi-Fi MAC/PHY modelled at all**.
10. Ships `esp32` and `esp32s3` machines. **No `esp32s2` machine** — so the *recommended DIY board*
    is unavailable. `esp32s3` boots ROM and bootloader but never reaches `setup()`.
11. **~28% of boots panic** with a cache error. Backtraces put core 0 in
    `cache_ll_l1_enable_bus ← cache_hal_resume ← spi_flash_restore_cache ← esp_flash_read ←
    nvs_flash_init`, core 1 parked in `spi_flash_op_block_func` on the IPC task — QEMU not modelling
    per-core cache state through ESP-IDF's dual-core flash protocol. I mitigate by relaunching.
12. **LEDC is modelled but inert.** Registers decode correctly (50.000 Hz exactly; 29/29 duty writes
    match the TRM formula), but the four LEDC functions contain no `timer_mod`, no `qemu_irq`, no
    GPIO output, and `led_get_intensity` has zero call sites in the binary. So no PWM waveform is
    ever produced, and servo evidence must come from instrumenting the firmware *above* the
    peripheral.

## Questions

### A. Is the Renode diagnosis correct?
1. Is it true that no public ESP32 platform (`.repl`/board) exists for Renode as of mid-2026? Any
   downstream forks, Antmicro customer work, conference talks, or unmerged PRs?
2. **Why** does Renode carry Xtensa CPU support with no ESP32 platform? Which target motivated the
   Xtensa work, and was ESP32 ever an intended destination?
3. Is the LX6-table-on-LX7-cores `#include` a known bug? Filed, discussed, deliberate placeholder?
4. Is the `rer`-aborts-the-emulator behaviour intentional (fail-fast on unimplemented external
   registers) or simply unfinished?

### B. Was the effort estimate realistic?
5. How long does bringing up a *new* SoC platform in Renode actually take, from people who have
   done it? Is 16–25 days to first user code plausible, optimistic, or naive?
6. Is Renode's peripheral-modelling cost per device genuinely lower than QEMU's, as its
   documentation implies? Any side-by-side accounts?
7. Renode's Python-peripheral escape hatch: real leverage for rapid SoC bring-up, or a prototyping
   toy that doesn't survive contact with a boot ROM?

### C. What did I forfeit?
8. Renode offers deterministic virtual time, snapshots, a GDB server, Robot Framework integration
   and multi-node networking. QEMU's ESP32 fork gives me none of that, and my ~28% boot flakiness
   is *precisely* the kind of nondeterminism Renode is built to eliminate. **How much does that
   cost a project whose value is reproducible teaching artefacts?**
9. Is there a defensible hybrid — Renode for CPU/determinism, with peripherals stubbed by a
   host-side behavioural model — that I dismissed too quickly?

### D. The wider landscape
10. Will Espressif's QEMU fork gain **ESP32-S2**? Is there a public roadmap, and is S2 deprioritised
    because it is single-core and older?
11. Is the QEMU dual-core cache/DPORT flakiness a known issue? Filed? Fixed on any branch?
12. Is **anyone** emulating ESP32 Wi-Fi MAC/PHY — QEMU, Renode, Wokwi, academic, commercial? Is it
    genuinely intractable, or merely unattempted?
13. **Wokwi** simulates ESP32 in-browser including Wi-Fi behaviour. What is it actually doing —
    real firmware execution, or a higher-level model? Licensing/self-hosting terms? Could it host
    custom firmware for an open-source education project?
14. Are there other ESP32 emulators worth knowing about — `esp32-emulator` projects, Renode forks,
    university work, or commercial simulators?

### E. Peripheral fidelity, given no hardware
15. My LEDC finding — correct registers, no waveform — means I cannot verify a servo pulse without
    a logic analyser I will never have. **Is there any emulator that models ESP32 LEDC as an actual
    waveform?** Has anyone verified ESP32 PWM timing under emulation against real silicon?
16. More generally: for peripherals that are *inert but register-accurate*, what verification
    strategies exist for someone who cannot touch hardware? Is cross-emulator agreement
    (QEMU vs Renode vs Wokwi producing identical register state) a legitimate substitute?

### F. Tell me I was wrong
17. What did I get wrong, misdiagnose, or measure badly?
18. Under what circumstances would Renode have been the better choice here?
19. Is my "behavioural simulator as the default, real-firmware emulator as an opt-in backend"
    architecture sound, or is it a rationalisation of an emulator that only half works?

## What good output looks like

Cite primary sources — repository files with paths, issue and PR numbers, commit hashes, release
notes, mailing-list and forum threads, conference talks. **Where you cannot find evidence, say so
explicitly rather than inferring**; "no public evidence of an ESP32 Renode platform as of
2026-08" is a genuinely useful answer. Distinguish throughout between *documented*, *reported by
practitioners*, and *your inference*. Prioritise questions A1, B5, D10, D12 and E15.
