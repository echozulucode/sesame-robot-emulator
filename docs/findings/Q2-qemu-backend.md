# Q2 — `QemuSesameRobot`: productising the QEMU spike

**Task:** Q2 · **Date:** 2026-08-23 · **Agent:** `qemu-backend`
**Follows:** `docs/findings/Q1-qemu-spike.md` (the spike this productises)
**Decision being executed:** adopt QEMU as a real emulator backend. *"The simulated is cool, but I
want an emulator."* The Renode track is superseded and closed `wont_fix`.

### Evidence labelling

| Tag | Meaning |
|---|---|
| `[RAN]` | **verified-by-running** on this machine |
| `[SRC]` | **found-in-source** — read out of a file or a binary here |
| `[INFER]` | **inferred** — reasoned, not observed |

---

## 0. The answer

> **QEMU is now a commandable backend.** `QemuSesameRobot` implements `SesameRobot`, boots real
> compiled Sesame firmware, takes commands over the firmware's own serial console on UART0, and
> reports state derived from the telemetry that comes back on the same wire. **All 15
> `describeRobotContract` cases pass, in 57 s, three runs in a row.** `[RAN]`
>
> ISSUE-20260823-022 is **root-caused but not fixed**. It is a modelling bug inside QEMU's ESP32
> cache/DPORT handling and there is no configuration that avoids it. `connect()` detects it in about
> two seconds and relaunches: **0 connect failures in 25 connects**, against a **28% per-boot**
> failure rate measured over 107 boots. `[RAN]`

```
$ node packages/sesame-qemu/dist/cli.js --command wave
booted in 2052 ms after 1 attempt(s)
--> command("wave")
    sent on UART0: "rn wv"
    firmware ran it in 3866 ms and replied with:
      29 servo.target
```
`[RAN]` — the same 29 servo events Q1 measured, now caused by a host command instead of a line
injected into `setup()`.

---

## 1. ISSUE-20260823-022 — root cause, and what did not fix it

### 1.1 Before: measured, not estimated

The issue recorded *"1 failure in 5 consecutive runs"*. Five runs is not a rate, so the first thing
built was `emulator/qemu/run-flake-trial.mjs`, which boots one image N times under a named
configuration and reports numbers.

**Baseline — Q1's exact configuration** (the `nowifi` image, `snapshot=off`, the fixed
`await sleep(1500)` before attaching): `[RAN]`

```
20 runs: 8 cache errors (40%), 6 runs with zero servo events (30%)
servo counts: 29 29 29 29 29  0 21 29  0  0  0 29 29 29 29  0 29 14  0 29
```

Two of the eight recovered — the guest panicked, printed `Rebooting...`, came back on
`rst:0xc (SW_CPU_RESET)` and then ran correctly. So "1 in 5" undercounted by roughly half: the
original sample was scoring a slow, self-recovering boot as a pass.

Pooled across every configuration measured in this task: **30 failures in 107 boots — 28%.** `[RAN]`

And the rate is **bursty**, which matters more than the mean. The retry-disabled control arm
(`measure-connect.mjs --attempts 1`) was run twice: **2 failures in 4** on the first sitting, and
**0 failures in 10** twenty minutes later. `[RAN]` Two samples do not establish a distribution, but
combined with the 7-attempt outlier in §1.4 they are enough to say that treating this as an
i.i.d. 28% coin is optimistic, and to size the retry budget for a run of bad luck rather than for
the average. `[INFER]`

### 1.2 The cause

The panic backtraces were resolved against the ELF with `xtensa-esp32-elf-addr2line`. Two distinct
signatures, both pointing at the same mechanism. `[RAN]`

**Signature A — the flash/cache dance during `nvs_flash_init`:**

```
Core 0:  cache_ll_l1_enable_bus            hal/esp32/include/hal/cache_ll.h:155
         cache_hal_resume                  hal/esp32/cache_hal_esp32.c:36
         esp_cache_resume_ext_mem_cache    esp_mm/esp_cache_utils.c:41
         spi_flash_restore_cache            spi_flash/cache_utils.c:352
         spi_flash_enable_interrupts_caches_and_other_cpu   cache_utils.c:208
         spi1_end / spiflash_end_default / esp_flash_read
         esp_partition_read_raw -> nvs::Page::load -> nvs_flash_init
         initArduino  (esp32-hal-misc.c:331)  -> app_main
Core 1:  spi_flash_op_block_func            spi_flash/cache_utils.c:108
         ipc_task
```

Core 0 is re-enabling the cache after a flash read; core 1 is the IPC task parked with its cache
disabled. Both fault with `EXCCAUSE 0x07`. This is the standard ESP-IDF dual-core protocol for
touching flash — `esp_ipc_call` stalls the other CPU, both caches go off, the read happens, both
come back — and QEMU does not model the per-core cache enable/disable state correctly through it.

**Signature B — the same fault, later:** both cores in `esp_vApplicationIdleHook` /
`esp_cpu_wait_for_intr`, faulting on an instruction fetch that should have come from cache. Same
root: the cache was left disabled by the other core's flash operation.

**A third variant, under a one-core host affinity mask:** core 1 faulted inside the mask ROM at
`call_start_cpu1`, i.e. APP-CPU startup overlapping a PRO-CPU flash operation. `[RAN]`

**Conclusion:** the trigger is `nvs_flash_init()`, which `initArduino()` calls unconditionally at
boot. It is the first dual-core flash operation in the boot sequence, and it is where the model
breaks. `[SRC]` + `[RAN]`

### 1.3 What was tried, and what each of them measured

| Hypothesis | Result | Verdict |
|---|---|---|
| `-drive …,snapshot=on` — Q1's recommendation, never applied by the demo | 20 runs: **6 cache errors (30%)** vs 8/20 (40%) without. Same population within noise. | **Not the cause.** Kept anyway: it is free, and without it the guest's NVS and core-dump writes mutate the image file. `[RAN]` |
| A race between QEMU's UART TCP bind and the fixed `sleep(1500)` before attaching | Excluded. The backtraces contain no UART code at all, and failures occur at attach times from 1507 ms to 1539 ms with no correlation. The client now poll-connects from t=0 (attaching at ~66 ms), which is a **detection** improvement — it is how the earliest panics become visible — not a fix. | **Not the cause.** `[RAN]` |
| `-accel tcg,thread=single` — serialise the two vCPUs onto one host thread | **The machine stops booting.** 20/20 runs produced no UART output whatsoever; a manual 30 s run reached `entry 0x4008059c` and then hung. | **Dead end.** `[RAN]` |
| `-icount shift=0` — deterministic instruction clock (implies single-threaded TCG) | No output at all, not even the ROM banner. | **Dead end.** `[RAN]` |
| `-smp 1` | No output at all. | **Dead end.** `[RAN]` |
| Pin the QEMU process to one host core (`ProcessorAffinity = 1`) — remove true host parallelism | **Still panicked**, with a *new* signature (core 1 in mask ROM). | **Not host parallelism.** It is the model. `[RAN]` |

Two further notes. QEMU issued no MTTCG warning for `-accel tcg,thread=multi`, so the two ESP32
cores really do run on two host threads by default — but the affinity result shows that is not what
makes the race happen. `[RAN]` And the failure rate differed between images (8/20 on `nowifi`, 4/20
on `cli`); with n=20 each those samples are not distinguishable, and nothing in the mechanism
suggests the application image should matter. `[INFER]`

### 1.4 After: the mitigation, measured

**No configuration fix exists, so `connect()` detects and relaunches.** Stated plainly, as asked:
**this is a mitigation, not a fix. The QEMU bug is untouched.**

`QemuSession` verifies boot against the firmware's own end-of-`setup()` banner
(`HTTP server & Captive Portal started.`, `bootOrder` step 20) and fails the attempt on any panic
pattern, including a guest-initiated `SW_CPU_RESET`. Detection takes about two seconds, so retrying
is cheap.

`emulator/qemu/measure-connect.mjs`, 25 connect/disconnect cycles: `[RAN]`

| | |
|---|---|
| connect failures | **0 / 25** |
| boot attempts consumed | 37, of which **12 failed → 32.4% per boot** |
| attempts per connect | 1×19, 2×4, 3×1, **7×1** |
| connect time | 2358 ms min, 2580 ms median, 17 355 ms max |
| retry-disabled control (`--attempts 1`) | 0/10 one sitting, 2/4 another — see §1.1 on burstiness |
| orphaned `qemu-system-xtensa.exe` | **0 / 25** |

The 7-attempt outlier is the interesting number. At an independent 35% per boot, six failures in a
row should occur about once in 1600 connects; seeing one in 25 is evidence that failures **cluster**
rather than being independent, which is plausible for a host-timing-sensitive race. `[INFER]` The
default retry budget is therefore **12**, not the 8 originally chosen — eight would have left almost
no margin above an outcome that was actually observed.

**Before / after, in one line:** per-boot 28% → unchanged; per-`connect()` 28% → **0/25 measured**,
plus 0/10 more on the retry-disabled arm that happened to hit a good streak.

### 1.5 What would actually fix it

Someone fixing QEMU's `esp32_dport` / cache-mux model so that
`spi_flash_disable_interrupts_caches_and_other_cpu` and its inverse are modelled per-core. That is
upstream work on Espressif's fork. Nothing in this repository can do it. `[INFER]`

---

## 2. Protocol v2 — the host → device direction

Full specification: `docs/protocol/sesame-telemetry-v2.md`. The three decisions worth defending
here.

### 2.1 v2 invents no wire format

The firmware already has a command channel: the serial console at `sesame-firmware-main.ino:785`,
26 forms, extracted by F4 into `hardware-map.json`. It is upstream code, unmodified, already
listening on the port the telemetry leaves by. Designing a nicer protocol would have meant patching
the firmware to speak it — weakening the exact claim an emulator backend exists to strengthen.

So **v2's host → device wire format *is* the upstream serial CLI**, and the package's job is to
encode into it safely.

### 2.2 `@SESAME hello` still says `1`

`hello` announces the *telemetry wire version*. v2 changes no verb, no tag, no framing rule, so
nothing about it moved. Bumping it would have required either patching
`telemetry-instrumentation.patch` to announce a version whose only content is a direction the
firmware does not implement, or leaving every conforming v1 emitter announcing a stale number.
`PROTOCOL_VERSION = 1` and `SPEC_VERSION = 2` are separate constants for that reason.

### 2.3 Surviving the prefix-sensitive dispatcher

`commands.serialCliDispatchNote` warns that matching is order-sensitive. The mitigation is not care;
it is a model. `classifyCliLine()` is a transcription of `:791`–`:872` **in source order**,
including both places the firmware disambiguates an abbreviation by peeking at `command_buffer[1]`
(`:819` for `fc`/`face`, `:847` for `st`/`subtrim`). `encodeCommand()` runs its own output through
it and refuses to return a line that reaches a branch other than the one intended.

Every one of the 26 extracted forms is pinned against the model, plus the traps by name: `[RAN]`

| Input | Branch | Why it matters |
|---|---|---|
| `st` | `subtrim-show` | One character from `rn st`, which stands the robot up. **`stand` is encoded as `run stand`** — three bytes, no ambiguity. |
| `st save` / `st reset` | `subtrim-save` / `subtrim-reset` | Both are `st `-prefixed and would hit branch 24 if 22/23 moved. The subtrim family is encoded with **long** spellings so the encoding does not depend on that ordering. |
| `fc save`, `face subtrim` | `face` | The face test is before every subtrim test, so these are faces named `save` and `subtrim`. |
| `st x` | `subtrim-set` | Does **not** fall through to the motor branch. |
| `all` (no trailing space) | `none` | Branch 25 requires it. |
| 40-byte `fc …` | `face`, truncated | `command_buffer[32]` drops the rest **silently** (`:874`), so encoding refuses over 31 bytes rather than truncating. |

**One thing the console cannot do: `stop`.** No verb exists. The only branch that clears
`currentCommand` is the face branch (`:821`), so `command.stop` encodes as `fc <currentFace>` — a
no-op on the panel too, because `setFace()` returns immediately for the face already showing
(`:904`). It is flagged `derived: true` with a note, and the current face must be *supplied* rather
than guessed, because guessing wrong would change the face.

### 2.4 The bridge control path

The hub's `socket.on('message', () => undefined)` was a deliberate safety property and was **not**
deleted. It is still the default. `--allow-control` opts in, with three properties enforced rather
than documented: loopback peers only (re-checked per message, not per bind address);
`--allow-control` + `--allow-remote` **refused at startup**; and no raw-text escape hatch — the only
thing that reaches the UART is `encodeCommand()` output. Every accepted and refused command is
announced on the telemetry stream as an `emulator`-channel log, so the reason a robot moved is in
the same ordered stream as the movement. Reasoning in full: `emulator/bridge/src/control.ts`.

### 2.5 Completion without an ack protocol

The console reads **one character per `loop()` iteration** (`:788` — a single `Serial.read()`, not a
drain loop) and executes a completed line synchronously inside that iteration. Two lines written
back to back therefore cannot interleave. Appending a read-only `subtrim` and waiting for its
`Subtrim values:` line fences the command in front of it, however long the choreography took — no
polling, no sleep, no assumption about emulator speed. Cost, stated: `recordInput()` runs at `:792`
for every console line including the barrier, so it refreshes `lastInputTime`. No read-only branch
avoids that.

---

## 3. `QemuSesameRobot`

New workspace package: **`packages/sesame-qemu`** (`@sesame-lab/sesame-qemu`).

**Why a separate package.** `sesame-sim` runs in a browser. This spawns processes and opens sockets
(`node:child_process`, `node:net`, `node:fs`), so folding it in would put a Node-only dependency on
the critical path of every consumer of the simulator, `apps/web` included.

```ts
const robot = new QemuSesameRobot();
await robot.connect();               // boots QEMU, retries past ISSUE-022, waits for setup()
robot.subscribe((e) => …);           // replayed boot telemetry, then live
await robot.command('wave');         // -> "rn wv" -> 29 real servo.target events
await robot.setFace('happy');        // -> "fc happy"
await robot.setJoint('L3', 42);      // -> "6 42"   (L3 is firmware channel 6)
await robot.setPose({ R1: 10, L3: 20 });  // three lines, firmware order, one barrier
await robot.getState();              // derived from telemetry, not from a local model
await robot.disconnect();            // kills QEMU and waits for the OS to confirm
```

### 3.1 `getState()` reports; it does not model

| Field | Where it comes from |
|---|---|
| `joints[j].commandedDeg` | the last `@SESAME servo j <deg>` seen — post-subtrim, post-clamp |
| `joints[j].measuredDeg` | **always `null`.** Eight MG90S on one-way PWM: no encoder, no pot tap, no current sense, no firmware path |
| `joints[j].simulatedDeg` | **absent.** Modelling slew here would be a simulator wearing an emulator's clothes |
| `joints[j].subtrimDeg` | **absent.** The console prints subtrim; nothing parses it back yet, so claiming a value would be claiming something unobserved |
| `face` | the last `@SESAME face` — i.e. what actually reached `updateFaceBitmap()` |
| `network.state` | `'unavailable'`. There is no radio to be disconnected from |
| `mode` | `'qemu'` (see §5) |
| `motion.command` | the in-flight word, else `''` — **derived, not guessed**: every console movement branch either never sets `currentCommand`, clears it immediately (`:795`–`:798`), or is a pose function that clears itself (`movement-sequences.h:106` ×15). After a completed console command it is always `""` |
| `observed.everObserved[j]` | **the honest bit.** False means `commandedDeg` is the documented power-on assumption (90°, the servo-library mid-point, and `setup()` deliberately writes no channel) rather than something the robot said |

### 3.2 Teardown

`disconnect()` kills QEMU and **awaits the process exit event** rather than returning after
`kill()`; on Windows `TerminateProcess` returns immediately, so a check straight afterwards would be
racing. Every live session is also in a module registry with a `process.on('exit')` hook, for the
case that actually bites: a test file that throws, or a Ctrl-C.

Verified by asking the OS, by PID, after the fact: **0 orphans in 25 connect/disconnect cycles**
(`measure-connect.mjs`) `[RAN]`, plus a dedicated `tasklist`-based assertion in
`lifecycle.test.ts`. `[RAN]`

### 3.3 One firmware-image change

> **Superseded default (2026-08-28, EXP6-QEMU).** `QemuSesameRobot` now boots
> **`distro-v1-esp32-cli-oled.flash.bin`** — this image plus `-DSESAME_TELEMETRY_OLED=1`, which puts
> the OLED framebuffer on the wire at a measured +1.0 % on a full `rn wv`. Everything below still
> describes the `cli` image accurately, and that image is still supported and still reports
> `oledFramebuffer: false`. See [`EXP6-QEMU-oled.md`](EXP6-QEMU-oled.md).


The Q1 `nowifi` image injects `currentCommand = "wave"` into `setup()`, because nothing could ask
the robot to move. That is now noise in front of every command, so
`build-qemu-images.mjs cli` builds **`distro-v1-esp32-cli.flash.bin`**: the same Wi-Fi elision and
the same R6 telemetry patch, with **no injected movement**. The robot boots idle, and every servo
event after `connect()` is attributable to a host command.

`make-nowifi-variant.mjs` gained `--scratch` and `--trigger`; the `nowifi` image is unchanged and
still builds. Nothing under `firmware/` or `reference/` was modified. `[RAN]`

Q1's §11 costing suggested promoting the elision into a reviewed `firmware/patches/qemu-nowifi.patch`.
That was **not** done, deliberately: the existing text-anchored script fails loudly if the patched
source moves, which a context diff does not, and it preserves line numbering so the `hardware-map.json`
boot ladder still lines up. Converting it to a patch would trade a real property for a conventional
one.

---

## 4. The contract suite

**All 15 cases pass, three consecutive runs, ~57 s per run.** `[RAN]` Each case gets a **fresh QEMU
boot**, because that is what the suite's factory contract means.

```
✓ C01 stand reaches the eight expected joint targets                    2336 ms
✓ C02 wave begins with the expected sequence                            6187 ms
✓ C03 setFace("rest") makes the face state rest                         4235 ms
✓ C04 setFace("stand") emits nothing — ISSUE-004 reproduced, not fixed  3523 ms
✓ C05 an invalid command does not move the robot                        3761 ms
✓ C06 getState returns a canonical RobotState                           4003 ms
✓ C07 GET /api/status returns the firmware key set                      1957 ms
✓ C08 POST /api/command runs a movement, and answers before it finishes 2240 ms
✓ C09 /api/status reports a face that is not on screen after stand      2620 ms
✓ C10 every route answers any verb, and only two check the method       6160 ms
✓ C11 unmatched paths: JSON 404 under /api/, portal 200 everywhere else 1953 ms
✓ C12 an argument with no "=" does not exist                            1964 ms
✓ C13 hostile face and command names are sanitised at the boundary      9564 ms
✓ C14 the server binds loopback by default …                            3960 ms
✓ C15 the settings round-trip survives                                  2079 ms
```

**No case was weakened or skipped.** One case was *corrected*, and it is recorded here because it
would otherwise be invisible:

> **C06** asserted `mode` against a hand-copied `['real', 'simulated', 'renode']`. `RobotMode`
> gained `'qemu'` for this backend, so the copy began rejecting a value the type permits — a
> different assertion from the one the case claims to make. It now checks against `ROBOT_MODES`
> itself. The requirement, "`mode` must be a `RobotMode`", is unchanged.

Reporting `'renode'` was the only alternative and it would have been false. `'qemu'` was added to
the union, with a guard and an exported constant so the next transcription cannot go stale.

Three cases are worth calling out because they pass for the *right* reason on this backend:

- **C04** — `setFace("stand")` emits nothing. Not because the backend suppresses it: the firmware's
  hook is inside `updateFaceBitmap()`, `countFrames()` returns 0 for a bitmap-less face, and the
  function is never reached. **The silence is the firmware telling the truth.** This is
  ISSUE-20260823-004 reproduced by execution rather than by modelling.
- **C02** — the wave's opening is the real `runWavePose()`: eight stand writes in firmware enum
  order, then `R4=80, L3=180, L2=90, R1=100`. 29 servo events, matching Q1's count exactly.
- **C05** — an unrecognised word is **rejected host-side** rather than sent. The firmware's
  unknown-command sink lives in `loop()`'s `currentCommand` dispatch, which the console does not go
  through; an unknown word on the console reaches the `sscanf` fallthrough and does nothing at all.
  Refusing says the same thing out loud, and stops a word like `st` being posted as a command and
  silently dumping subtrim values. The contract permits both branches explicitly.

**One case needed a backend behaviour that is worth naming**, because it is a real property of a
real emulator and not of a model: `currentFaceMode` powers on as `FACE_ANIM_LOOP` (`:58`), so a
multi-frame face emits a frame per second **forever**. `setFace()` therefore waits for the panel to
settle — either a quiet period, or the moment immediately after a frame lands — before returning. A
simulator has no such problem because its clock does not run when nobody is asking it to.

---

## 5. Provenance — emulated must never read as physical

QEMU events were tagged `provenance: "observed"`, and v1 §7.1 defines that as *"bytes crossed the
emulated UART, the firmware hook really ran, **or** the physical robot really moved"*. Three
different claims, one tag.

**What was chosen: a second, orthogonal field, not a fourth provenance value.**

Adding `'emulated'` to `Provenance` was the obvious move and it is wrong. `Provenance` answers *how
much epistemic weight does this carry*; origin answers *which boundary was crossed*. Merging them
forces a choice for every future backend — is a hardware-in-the-loop rig `observed` or `emulated`? —
and silently reclassifies every existing event.

```ts
QEMU_ORIGIN = {
  kind: 'emulator',
  engine: 'qemu-system-xtensa/9.2.2-esp_develop_9.2.2_20260417',
  board: 'distro-v1-esp32',                        // the LEGACY V1 board
  elided: ['wifi-mac','wifi-phy','http-server','captive-portal','mdns',
           'ssd1306-panel','servo-load','usb-cdc'],
  firmwareDeviations: [ 'FlashMode=dio bootloader …', 'Wi-Fi … commented out', 'R6 telemetry patch' ],
}
```

Every event this backend produces carries it — including plain boot-log lines and the
oversized-line warning, which were the two paths that did **not** go through the parser's common
constructor and so shipped with no origin at all. Found by a test asserting that *every* event has
one, rather than sampling the interesting kinds. `[RAN]`

`isPhysicallyObserved(event)` — `provenance === 'observed' && origin?.kind === 'physical-robot'` —
is the predicate a UI branches on before saying "the robot did this". **It is `false` for everything
this backend emits.** An absent origin also returns `false`: unknown is *not known to be physical*,
never physical by default.

`origin` is **not a wire field** and there is no tag for it. It is stamped by whoever owns the
transport, because the firmware has no way to know it is running under an emulator and must not be
asked to assert that it is not. `elided` is the field that carries negative evidence: without it,
"no Wi-Fi events" reads as "the radio was idle" rather than "there is no radio".

---

## 6. The honest limits, in `capabilities()`

`SesameCapabilities` is six booleans, and six booleans cannot say *"works, but only on the board
nobody is told to buy"*. `capabilities()` returns a widened `QemuCapabilities` — the interface is
satisfied, the caveats are machine-readable:

```
realHardware: false        firmwareExecution: true     oledFramebuffer: false
serialConsole: true        httpApi: false              physics: false

board: 'distro-v1-esp32'
unsupportedBoards: {
  'distro-v3-s3': 'boots ROM + bootloader, never reaches setup() … This is the CURRENT Distro board',
  's2mini':       'QEMU has no esp32s2 machine at all … This is the board the report RECOMMENDS for DIY',
}
commandChannel: 'serial-cli/upstream-1.0'
firmwareDeviations: [ … ]        elided: [ … ]        knownFlakiness: 'ISSUE-20260823-022: …'
```

`httpApi: false` is not "not implemented yet". Stock firmware asserts in `esp_phy_enable` at
`bootOrder` step 7 (Q1 §6) and `server.begin()` is one of the lines this image elides. The ten
firmware routes can still be served by `@sesame-lab/sesame-api` — that is a **host-side proxy**
speaking to the serial console, not the robot's own web server, and C07–C15 pass through exactly
that path.

`honesty.test.ts` asserts every one of these, and needs no emulator to do it: a capability flag that
quietly flips to `true` would otherwise be invisible until someone read a UI.

---

## 7. Reproducing everything

```bash
node emulator/qemu/fetch-qemu.mjs                        # pinned, checksum-gated
node emulator/qemu/build-qemu-images.mjs cli             # -> distro-v1-esp32-cli.flash.bin
pnpm --filter @sesame-lab/sesame-qemu build

# The bidirectional demo. Exit 0 only if the command produced servo telemetry.
node packages/sesame-qemu/dist/cli.js --command wave
node packages/sesame-qemu/dist/cli.js --command stand --face happy --json

# The acceptance test.
pnpm --filter @sesame-lab/sesame-qemu test

# The measurements in section 1.
node emulator/qemu/run-flake-trial.mjs --runs 20 --tag baseline
node emulator/qemu/run-flake-trial.mjs --runs 20 --snapshot on --tag snapshot-only
node emulator/qemu/run-flake-trial.mjs --runs 20 --accel tcg,thread=single --tag single-thread
node emulator/qemu/measure-connect.mjs --runs 25 --tag retry
node emulator/qemu/measure-connect.mjs --runs 10 --attempts 1 --command wave --tag no-retry
```

| Artefact | SHA-256 |
|---|---|
| `distro-v1-esp32-cli.flash.bin` | `6bf11f9a43c403b066537e9005d2f5d3958947edc31a38c9d25a36d97c89aab6` |
| ↳ its `.elf` | `16efcabfde53c6324e64692f748f07ef27c04070f303fb1a08dad06d57fd4ed0` |

Measurement JSON lands in `emulator/qemu/logs/flake-*.json` and `connect-*.json`; failed boots are
written out individually as `flake-<tag>-fail-<n>.log`. Committed here are the four summary JSONs
and three representative failure dumps — one per panic signature — rather than all forty, which are
duplicates of the same two backtraces.

One arm was run and is **not** committed, because it measured nothing: `--attach none` shows zero
output on every run for the trivial reason that nothing was reading QEMU's TCP UART. The
attach-race hypothesis was excluded by the backtraces (§1.2) and by the poll-connect change, not by
that arm.

---

## 8. What this document does not claim

- **It does not claim the flakiness is fixed.** §1.4. The QEMU bug is untouched; `connect()` retries
  past it. A CI job that boots QEMU without this backend will still see ~31%.
- **It does not claim determinism.** Q1 measured a byte-stable servo stream across three runs and
  that still holds, but the boot is demonstrably timing-sensitive and `-icount`, the usual answer,
  does not boot this machine.
- **It does not claim the emulated PWM is correct.** Q1 §15 flagged this as the first thing to verify
  and it remains unverified: `esp32.ledc` exists, but nobody has checked that it produces the right
  duty cycle for `attach(pin, 732, 2929)`. The servo evidence is the firmware's own hook, *above* the
  peripheral. **This is still the largest open fidelity question.**

  > **Answered 2026-08-24 (Q3, `docs/findings/Q3-ledc-fidelity.md`):** the duty *ratio* is correct —
  > 29 of 29 servo writes match the ESP32 TRM formula — and **no pulse, edge or 50 Hz frame is
  > produced at all**: QEMU's LEDC model has no timer, no output wire and no consumer of the duty
  > value. So the bullet above splits in two. *Duty-cycle correctness* is verified as far as a
  > register file can verify it; *pulse existence* is not verifiable under any emulator available to
  > this project, and only a logic analyser (checklist V6-14b, ISSUE-20260824-024) can settle it.
  > The sentence "the servo evidence is the firmware's own hook, above the peripheral" is now a
  > permanent property rather than a temporary gap. Two corrections fell out of the same work:
  > `attach(pin, 732, 2929)` yields a **2500 µs** maximum, not 2929 (ESP32Servo clamps it), and the
  > channels are 10-bit, so 89 of the 181 commandable angles alias. **Timing fidelity (the last
  > bullet but one) is untouched and remains open.**
- **It does not claim anything about the S2 or S3.** §6. The S3 boots and never reaches `setup()`;
  the S2 has no QEMU machine at all.
- **It does not claim timing fidelity.** `motorCurrentDelay`, `delayWithFace()` and the 50 Hz servo
  period were not measured against wall-clock or virtual time. A wave takes ~3.9 s under QEMU; what
  it takes on hardware is unmeasured, because no hardware exists in this project.
- **It does not claim subtrim is observable.** The console prints it and nothing parses it back, so
  `JointState.subtrimDeg` is left absent rather than assumed zero.
- **The 7-attempt outlier is one observation.** The clustering inference in §1.4 is `[INFER]`.

---

## 9. Follow-up: wiring the UI

Deliberately not done — `apps/web` was owned by another agent during this task. What it will need:

1. **A backend selector.** `QemuSesameRobot` is Node-only; the browser cannot import it. The web app
   talks to it through the existing bridge (`--allow-control`, loopback) or through
   `@sesame-lab/sesame-api`'s HTTP adapter in front of the robot. Both already work.
2. **Branch on `isPhysicallyObserved()`, never on `provenance === 'observed'`.** This is the one
   change that must not be skipped. Render `describeOrigin(event.origin)` next to anything a learner
   could read as a measurement.
3. **Show `capabilities().unsupportedBoards`.** A learner looking at a QEMU run is looking at the
   legacy V1 board. The S2 Mini pin diagram in the same UI is not what is executing.
4. **Expect a 2–17 s connect** and surface `bootAttempts` — a connect that needed 7 tries is
   ISSUE-20260823-022, and hiding it would recreate the under-measurement this task started with.
5. **`mode: 'qemu'`** is a new `RobotMode`. Anything switching on `mode` needs the arm.
6. **No OLED pixels.** `oledFramebuffer: false`. The face is `face.expression` names only, which V4's
   renderer already handles.
