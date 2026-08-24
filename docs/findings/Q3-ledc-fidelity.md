# Q3 — Is QEMU's ESP32 LEDC faithful enough to call the servo path verified?

**Task:** Q3 · **Date:** 2026-08-24 · **Agent:** `ledc-fidelity`
**Answers:** `docs/findings/Q2-qemu-backend.md` §8 — *"It does not claim the emulated PWM is correct …
**This is still the largest open fidelity question.**"* — and `Q1-qemu-spike.md` §15.

### Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | **verified-by-running** on this machine |
| `[SRC]` | **found-in-source** — read out of a file or out of the shipped binary here |
| `[INFER]` | **inferred** — reasoned, not observed |

---

## 0. The verdict

> **Modelled, arithmetically correct for duty ratio, and completely inert as a waveform.**
>
> QEMU's `esp32` machine does contain an LEDC device — `misc.esp32.ledc`, mapped at
> **`0x3FF59000`–`0x3FF59193`** with the APB alias at `0x60019000`. `[RAN]` It is not an
> unimplemented-device stub and it is not RAZ/WI. Every one of the firmware's 29 `servos[i].write()`
> calls reaches it and is converted to a duty percentage, and **all 29 percentages match the value
> the ESP32 TRM formula gives for the pulse ESP32Servo actually programmed.** `[RAN]`
>
> **But the model has no timer, no clock, no GPIO connection and no output.** Its entire behaviour is
> `duty × 100 / (2^duty_resolution − 1)` handed to `led_set_intensity()`, which clamps to 100, fires
> a trace event and stores one byte that **nothing else in the 71 MB binary ever reads** — the only
> other reference to `led_get_intensity` is its own definition, with zero callers. `[SRC]` The
> divider it was told to use is stored verbatim and never consulted; `LEDC_CONF_REG` (the clock
> selector) is not decoded at all and reads back `0`; the timer's live counter register aliases its
> own config register. `[RAN]`
>
> So: **QEMU tells you the correct duty *ratio*. It never produces a pulse, never produces an edge,
> and has no concept of 50 Hz.** "The registers hold plausible values" is exactly what happened here,
> and it is not "a pulse was produced."

The practical consequence, stated up front: **the instrumented firmware hook stays load-bearing.**
Removing it would lose the only per-joint, per-angle signal the backend has. What Q3 *does* buy is a
second, independent witness one layer below the hook — which caught two real firmware facts the hook
could never have shown (§6).

---

## 1. Step 1 — does QEMU model LEDC?  Yes.

### 1.1 It is a real device, at the real address

`info mtree` and `info qom-tree` from QEMU's own monitor, `-machine esp32`: `[RAN]`

```
000000003ff59000-000000003ff59193 (prio 0, i/o): misc.esp32.ledc
0000000060019000-0000000060019193 (prio 0, i/o): alias mr-apb-0x3ff59000 @misc.esp32.ledc 0..0x193

/machine/soc/ledc (misc.esp32.ledc)
    /led1 (led) … /led16 (led)
```

`0x3FF59000` is `DR_REG_LEDC_BASE` for the original ESP32, and `0x194` bytes covers the whole
register file up to and including `LEDC_CONF_REG` at `+0x190`. Contrast with the 20-odd peripherals
the same machine registers as `unimplemented-device` (`esp32.pcnt`, `esp32.rmt`, `esp32.i2s0/1`,
`esp32.slc`, `esp32.hinf`, `esp32.iomux`, `esp32.rtcio`, `esp32.analog`, `esp32.apbctrl`,
`esp32.slchost`) — LEDC is **not** one of them. `[RAN]`

### 1.2 What the model actually implements

The shipped Windows binary keeps its symbol table, so the device can be read directly:
`esp32_ledc_read`, `esp32_ledc_write`, `esp32_ledc_init`, `esp32_ledc_realize`,
`esp32_ledc_class_init` — 1 616 bytes of code in total, from `../hw/misc/esp32_ledc.c`. `[SRC]`

Disassembled (`objdump -d`), `esp32_ledc_write` decodes exactly three register families and drops
everything else: `[SRC]`

| Written register | What the model does with it |
|---|---|
| `LEDC_{HS,LS}CHn_CONF0` (16) | stores the raw word in `conf0[addr / 20]` |
| `LEDC_{HS,LS}CHn_DUTY` (16) | **does not store it.** Computes `pct = ((value >> 4) & 0xFFFFF) * 100 / ((1 << duty_res[timer]) - 1)` and tail-calls `led_set_intensity(&s->led[ch], pct)` |
| `LEDC_{HS,LS}TIMERn_CONF` (8) | stores the raw word; separately stores `value & 0xF` as that timer's `duty_res` **only if non-zero** |
| everything else | `addr` falls off the end of the decode chain and the function returns without storing anything |

`esp32_ledc_read` is narrower still — it answers only `CONF0` and `TIMERn_CONF`. **Everything else in
the 0x194-byte window returns 0**, including every `DUTY` register. `[SRC]`, confirmed by measurement
in §3.

Three things are *absent* from all 1 616 bytes, and their absence is the whole answer to step 3:

- **no `timer_new` / `timer_mod`** — there is no periodic callback of any kind;
- **no `qemu_irq`, no `qdev_init_gpio_out`, no `qdev_connect_gpio_out`** — `esp32_ledc_init` calls
  only `memory_region_init_io`, `sysbus_init_mmio`, `g_strdup_printf` and 16×
  `object_initialize_child(… "led%d" …)`; `esp32_ledc_realize` calls only 16× `qdev_realize`. The
  LEDC device is wired to nothing;
- **no use of `DIV_NUM`.** The divider is stored and never read back by any arithmetic. The model's
  only computation is the duty ratio. There is no frequency anywhere in it. `[SRC]`

---

## 2. Step 2 — the registers, read back out of the live peripheral

`emulator/qemu/probe-ledc.mjs` boots the image, waits for the firmware's own end-of-`setup()` banner
and for the 29 servo events, then attaches to **QEMU's GDB stub** and reads all 101 LEDC registers
with `m` packets. The read really does go through the device: gdbstub memory access runs through
`address_space_rw`, so an `m` at an MMIO address calls `esp32_ledc_read()`. Same hand-rolled GDB-RSP
client as `run-boot-ladder.mjs`, for the same reason (Q1 §4: the pinned `xtensa-esp-elf-gdb` cannot
`target remote` this stub at all). **This is the outside-the-guest route; no probe firmware was
needed, and none was written.**

It retries past ISSUE-20260823-022 rather than reporting a false negative. The run below took one
attempt; earlier trace-only runs took three. `[RAN]`

### 2.1 Non-zero registers, measured vs the ESP32 TRM

101 registers read, **12 non-zero**. `[RAN]` (`emulator/qemu/logs/ledc.json`)

| Offset | Register | Read back | Decoded (ESP32 TRM ch. 14) | TRM-expected for `attach(pin, 732, 2929)` @ 50 Hz |
|---|---|---|---|---|
| `0x000` | `LEDC_HSCH0_CONF0` | `0x00000004` | `timer_sel=0 sig_out_en=1 idle_lv=0` | ✅ channel enabled, on timer 0 |
| `0x014` | `LEDC_HSCH1_CONF0` | `0x00000004` | idem | ✅ |
| `0x028` | `LEDC_HSCH2_CONF0` | `0x00000004` | idem | ✅ |
| `0x03c` | `LEDC_HSCH3_CONF0` | `0x00000004` | idem | ✅ |
| `0x0a0` | `LEDC_LSCH0_CONF0` | `0x00000014` | `timer_sel=0 sig_out_en=1 para_up=1` | ✅ (`PARA_UP` is LS-only — internal proof these four really are low-speed writes) |
| `0x0b4` | `LEDC_LSCH1_CONF0` | `0x00000014` | idem | ✅ |
| `0x0c8` | `LEDC_LSCH2_CONF0` | `0x00000014` | idem | ✅ |
| `0x0dc` | `LEDC_LSCH3_CONF0` | `0x00000014` | idem | ✅ |
| `0x140` | `LEDC_HSTIMER0_CONF` | `0x0002710a` | `duty_res=10b  div_num=5000 (19.53125)  tick_sel=0  pause=0 rst=0` | ✅ **1 MHz ÷ 19.53125 ÷ 2¹⁰ = 50.000 Hz exactly** |
| `0x144` | `LEDC_HSTIMER0_VALUE` | `0x0002710a` | — | ❌ **artifact**: identical to `+0x140`. The model indexes timers by `addr >> 3`, so the counter register aliases the config register. On silicon this is a live 0…1023 counter |
| `0x160` | `LEDC_LSTIMER0_CONF` | `0x0402710a` | same + `para_up=1` | ✅ 50.000 Hz |
| `0x164` | `LEDC_LSTIMER0_VALUE` | `0x0402710a` | — | ❌ same aliasing artifact |

Everything else — **all 16 `DUTY` registers, all 16 `HPOINT`, all 16 `CONF1`, all 16 `DUTY_R`, the
four interrupt registers, and `LEDC_CONF` at `0x190`** — read back `0x00000000`. `[RAN]`

Two of those zeroes are load-bearing:

- **`LEDC_*CHn_DUTY` = 0 while duty writes were demonstrably happening.** 37 duty writes reached the
  model in this very run (§3). They are converted and discarded. A firmware that read its own duty
  back — which `ledc_get_duty()` does — would read zero under QEMU.
- **`LEDC_CONF` = 0.** This is the low-speed clock selector. It is outside the write decoder
  entirely (`addr − 0x140 = 0x50 > 0x38` → return, no store `[SRC]`), so we cannot see what the
  firmware put there, and neither can the model.

### 2.2 The clock-source bit, and the polarity trap

`TICK_SEL = 0` looks like "APB" if you read the bit name literally, and that reading gives 4 kHz,
not 50 Hz. ESP-IDF's own HAL settles it — `hal/esp32/include/hal/ledc_ll.h:233`: `[SRC]`

```c
hw->timer_group[speed_mode].timer[timer_sel].conf.tick_sel = (clk_src == LEDC_APB_CLK);
```

**0 means `REF_TICK` (1 MHz)**, 1 means APB (80 MHz). With REF_TICK the divider is
`1 MHz / (50 Hz × 1024) = 19.53125`, i.e. `div_num = 5000` — precisely the value measured. It could
not have been APB: 50 Hz from 80 MHz at 10-bit needs a divider of 1562.5, and `DIV_NUM`'s integer
part is only 10 bits (max 1023), so the configuration is unrepresentable. `[INFER]`

**The firmware programmed the peripheral correctly for a 50 Hz servo frame. QEMU stored the numbers
and did nothing with them.**

### 2.3 High-speed *and* low-speed — the detail that was easy to get wrong

The task flagged this. The answer is **both groups**, four channels each, and it is fully explained
by two sources plus the register file: `[SRC]` + `[RAN]`

- `ESP32PWM::timerAndIndexToChannel()` hands out the channels whose `(j/2) % 4` equals the requested
  timer, so its "timer 0" is channels `{0, 1, 8, 9}` and its "timer 1" is `{2, 3, 10, 11}`. Eight
  servos fill both.
- arduino-esp32 3.3.11 `esp32-hal-ledc.c:222` maps `group = channel / SOC_LEDC_CHANNEL_NUM` — so
  channels 0–7 are the **high-speed** group and 8–15 the **low-speed** group. `{0,1,2,3}` → HSCH0–3,
  `{8,9,10,11}` → LSCH0–3. Exactly the eight `CONF0` registers that came back non-zero.
- `esp32-hal-ledc.c:59 find_matching_timer()` reuses a hardware timer when frequency *and*
  resolution match within the same speed group. All eight servos are 50 Hz / 10-bit, so each group
  collapses onto its timer 0 — which is why `timer_sel = 0` everywhere and why **only two of the
  four timers `ESP32PWM::allocateTimer(0..3)` reserves are ever programmed** (§6.3).

Nothing here is S2/S3-flavoured: this is the original ESP32's two-group LEDC, on `distro-v1-esp32`.

---

## 3. The duty cycle itself — 29 / 29 exact

The LEDC model's one externally visible output is the `led_set_intensity` trace event, and
**QEMU's trace backend does work in this Windows build** (Q1 §5 said otherwise — see §6.1). Running
the Wi-Fi-elided image with `-d trace:led_set_intensity` produces exactly **37 events: 8 from
`attach()` and 29 more that line up one-for-one, in order, with the 29 `@SESAME servo` lines the
firmware hook emitted in the same run.** `[RAN]`

The expected column below is computed from the **library source, not from the emulator**:

```
ESP32Servo.h:98    MAX_PULSE_WIDTH 2500
ESP32Servo.cpp:126 if (max > MAX_PULSE_WIDTH) max = MAX_PULSE_WIDTH;   // 2929 -> 2500
ESP32Servo.h:87    DEFAULT_TIMER_WIDTH 10                              // 1024 ticks
ESP32Servo.cpp:260 usToTicks(us) = (int)(us / (20000 / 1024))
ESP32 TRM ch.14    duty% = duty / (2^duty_res - 1) * 100
```

| joint / angle | QEMU duty % | pulse µs | ticks | true duty % | TRM-expected % | match |
|---|---:|---:|---:|---:|---:|:--:|
| `R4 0` | **3 %** | 722.7 | 37 | 3.613 % | 3 % | ✅ |
| `R2 45` | **5 %** | 1171.9 | 60 | 5.859 % | 5 % | ✅ |
| `R4 80` | **7 %** | 1503.9 | 77 | 7.520 % | 7 % | ✅ |
| `L2 90` | **8 %** | 1601.6 | 82 | 8.008 % | 8 % | ✅ |
| `R1 100` | **8 %** | 1699.2 | 87 | 8.496 % | 8 % | ✅ |
| `R1 135` | **10 %** | 2050.8 | 105 | 10.254 % | 10 % | ✅ |
| `R3 180` | **12 %** | 2500.0 | 128 | 12.500 % | 12 % | ✅ |

**29 of 29 events match.** `[RAN]` The trace prints an integer percent because the model's arithmetic
is integer, so the *resolution* of this measurement is 1 % — enough to confirm the mapping is right,
not enough to catch a sub-percent error. Stated so nobody over-reads it.

Note the numbers are not the naïve 3.66 % / 14.65 % you get from 732 / 2929 µs, and the reason is
§6.2, not an emulator fault.

---

## 4. Step 3 — does anything actually toggle?  No.

This is the part that decides the deliverable, so it is argued from five independent directions.

1. **No timer exists.** All four LEDC functions disassemble to 1 616 bytes containing no
   `timer_new`, `timer_mod`, `qemu_clock_*` or callback registration of any kind. A PWM peripheral
   that generates a waveform needs one. `[SRC]`
2. **No output wire exists.** `esp32_ledc_init` / `esp32_ledc_realize` contain no
   `qdev_init_gpio_out`, no `qdev_connect_gpio_out`, no `qemu_irq`. The device is not connected to
   `esp32.gpio` or to anything else. `[SRC]`
3. **The value has no consumer.** `led_set_intensity` clamps to 100, fires a trace event, and stores
   one byte in `LEDState`. Grepping the whole disassembled binary for references to
   `led_get_intensity` — the only API that reads that byte — returns **zero call sites**. The three
   other references to `led_set_intensity` are inside `hw/misc/led.c` itself. `[SRC]`
4. **It is not exposed to the outside either.** `qom-get /machine/soc/ledc/led1 intensity` →
   `Error: Property 'led.intensity' not found`. `[RAN]` The trace event is the *only* escape route,
   and a trace event is a debug print, not a signal.
5. **The peripheral's own counter is fake.** `LEDC_HSTIMER0_VALUE` read back byte-identical to
   `LEDC_HSTIMER0_CONF` (§2.1). On silicon that register is a free-running 0…1023 counter and is the
   most direct evidence a timer is turning. Under QEMU it is the config word, because nothing is
   counting. `[RAN]`

One refinement worth recording: the model emits `led_change_intensity` **23** times against
`led_set_intensity`'s **37** in the same run `[RAN]` — the generic LED device suppresses repeats. So
even the trace is edge-triggered on *value change*, not on any electrical edge.

> **Verdict on step 3, plainly: the registers hold correct values; no pulse, no edge and no waveform
> is produced. QEMU's LEDC is a duty-percentage sink with a debug print on it.**

---

## 5. Step 4 — what this means for the project

### 5.1 The instrumented hook stays. Say so out loud.

Our servo evidence is, and under QEMU permanently will be, **above the peripheral**. The
`@SESAME servo <joint> <deg>` hook at `setServoAngle()` is not scaffolding that better emulation
will retire — it is the only source of per-joint identity and per-joint angle in the system. QEMU's
LEDC output carries neither: the trace event is a bare percentage with `desc:'n/a'`, with no channel
number, no pin, and no joint name.

**Recommended, not done here** (`packages/sesame-qemu/` is out of this task's scope). Two additions,
in `packages/sesame-qemu/src/config.ts`:

- to `elided`: **`'ledc-waveform'`** — alongside `'servo-load'`. `elided` is the field Q2 §5 built to
  carry negative evidence, and this is negative evidence of exactly that shape: no LEDC events is
  "there is no waveform generator", not "the pin was idle".
- to `firmwareDeviations` (or better, a new `peripheralFidelity` note, since it is not a firmware
  deviation): *"LEDC duty ratio is modelled and correct (Q3, 29/29); LEDC frequency, GPIO output and
  waveform are not modelled at all. Servo evidence comes from the firmware's instrumentation hook,
  above the peripheral."*

And `honesty.test.ts` should pin it, the same way it pins `httpApi: false`.

### 5.2 What it would take to verify duty cycle *properly*

| Route | Cost | What it would actually prove | Verdict |
|---|---:|---|---|
| **Patch QEMU's `esp32_ledc.c`** to keep `DIV_NUM`, run a `QEMUTimer` at the computed period and drive a `qemu_irq` into `esp32.gpio` | **3–6 d** `[INFER]`, plus a build toolchain for QEMU on Windows that this repo does not have | that the *model* toggles a pin at the frequency the model computed. It would still be QEMU's arithmetic checking QEMU's arithmetic | **No.** Circular, and it buys nothing the §3 table has not already established |
| **Re-derive from registers**, as done here | already done, ~0 d to re-run | the firmware programmed the peripheral correctly. This is the useful claim and we now have it | **Done** |
| **A different emulator** | — | Renode is closed `wont_fix` and never modelled LEDC either. No ESP32 emulator known to us generates real LEDC waveforms | **No** |
| **Logic analyser on real hardware** | V6 checklist's job | the only thing that can prove a *pulse* — edge timing, 50 Hz frame, jitter, and whether an MG90S actually lands where 2 500 µs says | **Yes — this and only this.** |

The honest framing: **duty-cycle *correctness* is now verified as far as a register file can verify
it, and pulse *existence* is not verifiable under any emulator we have.** Those are different
questions and Q1/Q2 were right to keep them separate.

### 5.3 What Q3 removes from the open-questions list, and what it leaves

Closed: *"nobody has checked that QEMU's LEDC produces the right duty cycle for `attach(pin, 732,
2929)`"* (Q1 §15, Q2 §8). Answered: the duty ratio is right, and the pulse does not exist.

Still open, unchanged: **timing fidelity** (Q2 §8). Q3 measured the *configured* period, not elapsed
virtual or wall-clock time. Nothing here says a QEMU second is a robot second.

---

## 6. Corrections to earlier findings

### 6.1 Q1 §5 / §10: "the trace backend is a no-op in this Windows build" — **wrong**

`-d trace:led_set_intensity` and `-trace led_set_intensity` both work and both produced 37 events.
`[RAN]` The backend is compiled in; the disassembly shows the `qemu_loglevel & LOG_TRACE` path
intact. `[SRC]`

Q1's underlying *observation* still stands, though, and the corrected statement is narrower and more
useful: enabling `-trace 'i2c_*' -trace 'esp32_*' -trace 'led_*'` over a full boot fires **37
`led_set_intensity`, 23 `led_change_intensity`, and zero `i2c_*` and zero `esp32_*`.** `[RAN]` The
events exist in `-trace help`; they simply never fire, because Espressif's device models do not call
the generic `hw/i2c/core.c` trace points and define no `esp32_*` ones of their own. So Q1 §5's "does
any I²C transaction reach the controller" remains unanswered — but for a different reason, and the
trace backend is now a usable tool rather than a dead end.

### 6.2 `attach(pin, 732, 2929)` does **not** give a 2 929 µs pulse — ESP32Servo clamps it to 2 500

`ESP32Servo.h:98` defines `MAX_PULSE_WIDTH 2500` and `ESP32Servo::attach()` (`ESP32Servo.cpp:126`)
applies `if (max > MAX_PULSE_WIDTH) max = MAX_PULSE_WIDTH;` **before storing it**. `[SRC]` The
firmware's requested 2 929 µs is silently discarded. The measured duty percentages confirm it
independently: 180° produced 12 %, which is 2 500 µs at 20 ms, not the 14.6 % that 2 929 µs would
give. `[RAN]`

This is a property of the real robot, not of QEMU. It affects:

- `hardware/hardware-map.json` → `servos.servoConfig.attachMaxPulseUs: 2929` — accurate as a record
  of the *call*, misleading as a record of the *pulse*. It wants a sibling note.
- `packages/sesame-model/src/calibration.ts:269` — *"given `attach(pin, 732, 2929)`. Assumed exactly
  1.0; never measured."* The assumed-linear map is over the wrong range at the top end. Effective
  range is **732 → 2 500 µs**, and the quantised pulses are **722.7 → 2 500.0 µs** (10-bit ticks
  37 → 128 at a 20 ms frame), i.e. **19.53 µs per LEDC tick, ~1.98° of commanded angle per tick**.
- `docs/findings/F4-doc-drift.md:288` records "attach 732–2929 µs" as an *exact match* between report
  and source. It is an exact match between the report and the *call*; the library then overrides it.

Neither the firmware's instrumentation hook nor any amount of QEMU work would have surfaced this —
it took looking at the peripheral. That is the concrete value Q3 delivered beyond its verdict.

### 6.3 Four timers are allocated; two are used

`hardware-map.json` → `servoConfig.pwmTimersAllocated: [0,1,2,3]` records
`ESP32PWM::allocateTimer(0..3)`. Measured, **only `HSTIMER0` and `LSTIMER0` are ever programmed** —
one per speed group — because arduino-esp32 3.3.11's `find_matching_timer()` shares a timer across
channels with identical frequency and resolution, and all eight servos are 50 Hz / 10-bit. `[RAN]`
The map's field is a correct record of the call; the hardware effect is different.

### 6.4 The servo channels are 10-bit, not 16-bit

`ESP32Servo.h:87 DEFAULT_TIMER_WIDTH 10`. `[SRC]` Confirmed in the register file: `duty_res = 10`.
`[RAN]` So there are **1 024 steps across the whole 20 ms frame**, of which only ticks 37…128 —
**92 distinct values, verified by enumerating all 181 angles** `[RAN]` — are reachable across 0–180°.
The firmware's `constrain(angle + subtrim, 0, 180)` offers 181 distinct commands; **89 of them alias
onto a neighbour at the pin.** Anything in
the UI or the simulator that implies 1° of servo resolution is over-claiming, on real hardware as
much as under QEMU. `[INFER]` from two `[SRC]`/`[RAN]` facts.

---

## 7. Reproducing everything

```bash
# 0. Prerequisites (Q1 §14): fetch QEMU, build the images.
node emulator/qemu/fetch-qemu.mjs
node emulator/qemu/build-qemu-images.mjs nowifi

# 1. Is there an LEDC device, and where? (QEMU's own monitor; needs no firmware)
printf '\ninfo mtree\ninfo qom-tree\nquit\n' \
  | tools/qemu/qemu/bin/qemu-system-xtensa.exe -machine esp32 -nographic -S -monitor stdio -serial none \
  | grep -iE 'ledc|3ff59'

# 2. What does the model do?  (symbols are in the shipped binary)
nm tools/qemu/qemu/bin/qemu-system-xtensa.exe | grep -i esp32_ledc
objdump -d --start-address=0x1400906d0 --stop-address=0x1400909c0 \
  tools/qemu/qemu/bin/qemu-system-xtensa.exe      # esp32_ledc_write
objdump -d --start-address=0x140090380 --stop-address=0x1400904c0 \
  tools/qemu/qemu/bin/qemu-system-xtensa.exe      # esp32_ledc_read

# 3. THE MEASUREMENT: read the LEDC register file back out of the running
#    peripheral over QEMU's gdbstub, and compare 29 duty writes against the TRM.
#    Retries past ISSUE-20260823-022.
node emulator/qemu/probe-ledc.mjs --tag ledc

# 4. Which trace events actually fire over a whole boot?
tools/qemu/qemu/bin/qemu-system-xtensa.exe -nographic -machine esp32 \
  -drive file=emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin,if=mtd,format=raw,snapshot=on \
  -trace 'i2c_*' -trace 'esp32_*' -trace 'led_*' -D /tmp/trace.log
awk '{print $1}' /tmp/trace.log | sort | uniq -c | sort -rn
```

| Artefact | Value |
|---|---|
| QEMU | `9.2.2 (esp_develop_9.2.2_20260417)`, `tools/qemu/qemu/bin/qemu-system-xtensa.exe` |
| Image used | `emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin`, SHA-256 `aea0dee34efa0b5b5c6397e37660c16de8d36706714679f4e4b887f03af2a48a` |
| ESP32Servo | `3.0.9`, `tools/arduino-data/data/internal/ESP32Servo_3.0.9_442075ee231ab4b5/` |
| Arduino ESP32 core | `3.3.11`, `…/packages/esp32/hardware/esp32/3.3.11/cores/esp32/esp32-hal-ledc.c` |
| ESP-IDF HAL | `…/esp32_esp32-libs_3.3.11_*/include/hal/esp32/include/hal/ledc_ll.h` |

**New script:** `emulator/qemu/probe-ledc.mjs`.
**Logs:** `emulator/qemu/logs/ledc.json` (all 101 registers + the 29-row comparison),
`ledc-trace.log`, `ledc-uart.log`.

**No probe firmware was written**, and `firmware/probes/` was deliberately not created: the GDB-stub
route reads the same registers from outside, needs no rebuild, and cannot perturb the thing it is
measuring. Nothing under `firmware/`, `reference/`, `packages/`, `apps/` or `hardware/` was modified
by this task.

---

## 8. What this document does not claim

- **It does not claim QEMU produces a pulse.** §4. It claims the opposite, and that is the finding.
- **It does not claim QEMU runs the LEDC at 50 Hz.** The **firmware** configured 50.000 Hz and the
  register file proves it; QEMU stores `div_num` and never uses it. Those are different sentences and
  they must not be collapsed.
- **It does not claim sub-1 % duty accuracy.** The trace event prints an integer percent (§3), so the
  measurement's resolution is 1 %.
- **It does not claim the real robot's pulse widths were measured.** §6.2's 722.7–2 500.0 µs is
  derived from library source plus a 10-bit resolution read out of the emulated register file. On
  real silicon it needs a logic analyser — the V6 checklist's job.
- **It does not claim anything about the S2 or S3.** This is `distro-v1-esp32`, the original ESP32
  with two LEDC speed groups. The S2/S3 have only low-speed channels, so §2.3's group split does not
  transfer.
- **It says nothing about timing fidelity.** Q2 §8's open item is untouched.
- **The 3–6 d QEMU-patch estimate in §5.2 is `[INFER]`** and uncalibrated, and it is a
  recommendation *against* doing the work regardless of what it costs.
