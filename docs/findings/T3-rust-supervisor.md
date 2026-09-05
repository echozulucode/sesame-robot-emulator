---
task: "T3 — the Rust supervisor"
phase: 5
status: complete
date: 2026-09-05
owns: src-tauri, justfile, docs/findings
plan: docs/plans/phase-5-tauri-desktop-app.md §5 T3
follows: docs/findings/T2-tauri-resources.md §6
---

# T3 — Rust owns the process and the socket, and nothing else

**Done when:** the two things a webview cannot do are Rust's, the boot-panic
retry is ported with its measured numbers, and **no `qemu-system-xtensa.exe`
survives a window close, an app crash, or repeated start/stop.** It does. §5 is
the teardown evidence, run adversarially and with a negative control, because a
check that always passes proves nothing.

`docs/findings/` is gitignored but tracked files inside it still commit, exactly
as every finding before it did. This file is meant to be committed and needs
`git add -f`.

---

## 1. The boundary, and what did not cross it

```text
Rust (src-tauri/src)                      TypeScript (T4, unchanged from web)
─────────────────────────────────────     ──────────────────────────────────
spawn qemu-system-xtensa      ──┐
TCP connect to UART0            ├──► raw bytes ──► SesameTelemetryParser
stream bytes on a Channel     ──┘                  (255 tests, chunk-invariant)
write serial-CLI bytes        ◄──── encodeCommand()
boot-panic retry (~28%)                            SimulatedSesameRobot, the UI
report the origin's facts
```

**The `@SESAME` parser was not ported, and neither was `encodeCommand`.** That
is the whole of option C (plan §4) and the reason it was chosen. What *was*
ported from `packages/sesame-qemu/src/session.ts` is the half that is about a
process that can die, a socket that can refuse, a guest that can panic before it
prints anything, and a Windows PID that must not be left behind.

One thing from `session.ts` that had to come along and is easy to mistake for
the parser: the **banner and panic scanner**. `session.ts` runs it on the raw
byte stream *outside* the parser, and says why — this is plain `Serial.println`
output and a panic dump is not line-shaped in any way the protocol cares about.
Without it there is no retry loop, because there is no way to tell a boot that
worked from a boot that panicked. It is 60 lines in `src/qemu/boot.rs`, it
matches three string literals and one hex-run pattern, and it consumes nothing.

## 2. The command surface

| Command | Signature | Notes |
|---|---|---|
| `spawn_emulator` | `(options: SpawnOptions, uart: Channel<Response>, events: Channel<SupervisorEvent>) -> Result<SessionInfo, QemuError>` | stops any existing session first |
| `stop_emulator` | `() -> Result<StopReport, QemuError>` | `wasRunning: false` is not an error |
| `send_command` | `(bytes: Vec<u8>) -> Result<usize, QemuError>` | raw; one `write_all` |
| `emulator_status` | `() -> StatusReport` | cheap, safe to poll, reports `guestPanic` |

All owned parameter types, all `Result<T, E>` with `E: Serialize` tagged by
`kind` (`artifactMissing` · `bootFailed` · `notConnected` · `writeTooLarge` ·
`io`). The three that block run on `tauri::async_runtime::spawn_blocking`, so a
12-attempt boot never touches the thread that draws the window and **no second
async runtime is introduced**.

### Two channels, and the reason it is two

```text
uart   : Channel<tauri::ipc::Response>   raw bytes → ArrayBuffer in JS
events : Channel<SupervisorEvent>        JSON progress, never bytes
```

`Response::new(Vec<u8>)` is an `InvokeResponseBody::Raw`, so the webview gets an
`ArrayBuffer` rather than a JSON array of 4,096 numbers per OLED frame. `Channel`
stamps every message with an index and the JS side reassembles in order, which
matters because a reordered byte stream is a corrupted one.

The split is not tidiness. **The byte channel carries the wire and nothing
else**, and the sharpest case is QEMU's own stdout/stderr: it goes on the
*event* channel as `diagnostic` and never on the byte channel, for the reason
`session.ts` gives —

> a log event claiming `provenance: observed` for something the emulator said
> about itself would be exactly the kind of laundering this package exists to
> avoid.

`qemuDiagnosticsInStream` in §4's report is that rule, asserted against the real
stream on every cycle.

### `SupervisorEvent`

`attempt` · `attemptFailed` · `booted` · `guestPanic` · `diagnostic` ·
`exited` · `stopped`. `attempt` and `attemptFailed` carry `{attempt, of}`
because the plan (§7) is explicit that a silent 17-second freeze reads as a
hang, and V7 already learned that once.

## 3. The spawn arguments, against `session.ts` line for line

`LaunchOptions::args()` produces, for a session on port *P*:

```text
-display none -machine esp32
-drive file=<image>,if=mtd,format=raw,snapshot=on
-serial tcp:127.0.0.1:P,server=on,wait=off
```

`session.ts` `#spawn()`:

```ts
const drive = `file=${imagePath},if=mtd,format=raw${snapshot ? ',snapshot=on' : ''}`;
const args = ['-display','none','-machine',machine,'-drive',drive,
              '-serial',`tcp:127.0.0.1:${port},server=on,wait=off`];
```

**Identical, and asserted as a unit test** (`the_arguments_are_session_ts_s_arguments`)
rather than compared by eye. Every default is `resolveQemuOptions()`'s: machine
`esp32`, `bootAttempts` 12, `bootTimeoutMs` 15000, `uartPort` 0 (ask the OS),
`snapshot` **true**.

`snapshot=on` is in the argv of every run in this document — §4 prints the argv
verbatim for exactly that reason. T2 §6.3 is why it must never be lost: `if=mtd`
is read-write, and without it the guest's NVS and core-dump writes mutate the
shipped image.

### Deviations from `session.ts`, all deliberate, all three of them

1. **Paths are not defaulted, they are resolved.** T2 §6.2:
   `DEFAULT_QEMU_PATH` / `DEFAULT_IMAGE_PATH` derive from `import.meta.url` and
   are meaningless inside a packaged `.exe`. `LaunchOptions` has no defaults for
   either, and `supervisor::options_from_resources()` is the only place they
   come from — `resources::resolve(app, QEMU_EXE | FLASH_IMAGE)`.
2. **`SpawnOptions` carries no path fields.** The frontend can set the attempt
   budget, the timeout, the port and `snapshot`; it cannot choose what it is
   talking to. A webview that could hand in an arbitrary image could change what
   `capabilitiesForImage()` reports about pixels it did not observe. Asserted
   (`spawn_options_carry_no_paths`).
3. **`MAX_BATCH_BYTES` is enforced in Rust.** `session.ts` throws over 192
   bytes; so does `send_command`, with the same reason: arduino-esp32's UART
   ring buffer is 256 bytes, the console drains it one character per `loop()`,
   and the overflow is *silent*. That is a property of the wire, which is the
   layer Rust owns — not protocol framing, which is not. Configurable via
   `SpawnOptions` if T4 ever needs it to be.

**Not ported, and this is the part T4 has to own:** the barrier protocol. The
completion fence (`BARRIER_COMMAND` / `BARRIER_MARKER`, `runCliLines`'s
`#barriers` counter, `faceSettleMs`) is protocol, it lives in
`@sesame-lab/sesame-protocol` with its tests, and it is expressed in *parsed
events* rather than in bytes. `send_command` writes and returns; it does not
wait for a barrier, because waiting requires the parser. Also not ported:
`commandTimeoutMs`, `faceSettleMs`, `faceSettleMaxMs`, `POWER_ON_ANGLE_DEG`,
`QemuCommandTimeoutError` — all of them belong above the byte layer.

## 4. The retry loop, and the numbers it was given

ISSUE-20260823-022 is a modelling bug in QEMU's ESP32 cache/DPORT handling
around the dual-core flash dance in `nvs_flash_init`. It is not fixable from
outside QEMU: `snapshot=on` does not change the rate, and both knobs that would
serialise the cores stop the machine booting at all (Q2 §1.3). The mitigation is
that the failure is independent per boot and detected in about two seconds.

Q2's measurements, and what T3 measured re-running the same mitigation through
Rust against the **bundled** QEMU:

| | Q2 (Node) | T3 (Rust), 13 cycles across two profiles |
|---|---|---|
| per-boot failure rate | 28% (30 of 107) | 23% (3 of 13 boots in the 10-cycle run) |
| detection | ~2 s | 1.80–1.85 s per failed attempt |
| worst case | 7 attempts | 3 attempts |
| budget | 12 | **12**, unchanged |
| connect failures | 0 in 25 | **0 in 13** |
| successful boot | ~2 s | 1.68–1.98 s |

The budget stayed at 12 rather than being re-derived from a smaller sample. Q2's
reasoning holds: seven-in-a-row was *observed* in 25 connects, which is evidence
the failures cluster rather than being independent, and eight would leave almost
no margin above an outcome that actually happened.

The panic text reported is whichever of the four patterns matches first *in list
order*, matching `firstPanic()` exactly. In practice T3 saw
`Guru Meditation Error` rather than `Cache disabled but cached memory region
accessed`, because detection is eager — the scan runs after every read, and
ESP-IDF prints `Guru Meditation Error: Core 0 panic'ed (Cache disabled ...)` in
that order, so the tail is scanned before the parenthetical arrives.
`session.ts` scans on every `data` event and behaves identically; this is a
detail of when, not of what.

### Size

763 lines of non-test, non-comment code for the supervisor
(`qemu/mod.rs` 624, `job.rs` 84, `boot.rs` 55) plus 148 for the Tauri adapter —
911 against the plan's estimate of 400–600. The overrun is the retry loop's
event reporting and the teardown machinery, both of which the plan named as
requirements rather than counted. `selftest.rs` is a further 286 and is a test,
not shipped behaviour.

### `just tauri-emulator`

```text
sesame-lab-desktop.exe --emulator-selftest [out.json] [--cycles N] [--hold-ms N]
```

Same precedent as T2's `--resource-report`, same reason: verifying that the
emulator boots by opening the window and watching it is verification by
screenshot. Each cycle boots the bundled QEMU through the same
`launch_with_retry` the command uses, collects every UART0 byte, stops, and then
asks **`tasklist`** — not its own bookkeeping — whether the PID is still there.
The raw stream is written beside the report as `.cycleN.uart.bin`, unaltered, so
the summary can be checked rather than believed.

Release build, three cycles, exit 0:

```json
{ "cycle": 3, "ok": true, "attempts": 3, "bootMs": 1922, "totalMs": 6136,
  "uartBytes": 1786, "bannerInStream": true, "bannerOffset": 1749,
  "sesameMarkersBeforeBanner": 3, "qemuDiagnosticsInStream": false,
  "diagnosticsOnEventChannel": 3, "survived": false,
  "args": ["-display","none","-machine","esp32","-drive",
           "file=...\\distro-v1-esp32-cli-oled.flash.bin,if=mtd,format=raw,snapshot=on",
           "-serial","tcp:127.0.0.1:58147,server=on,wait=off"],
  "engine": "QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)",
  "imageName": "distro-v1-esp32-cli-oled.flash.bin",
  "teardownEnforcedByJobObject": true }
```

`survivors: []`, `qemuPidsAfter: []`, ten-cycle run also exit 0.

## 5. Teardown — the risk that was going to bite

### The mechanism: a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`

One job per session, created *before* the process, `AssignProcessToJobObject`
immediately after. `TerminateJobObject` is the deliberate stop; the **guarantee**
is that the job handle is held by this process and nothing else (null security
attributes, so it is not inheritable), so when this process dies for any reason
its handles close, the job's last handle closes, and the kernel terminates
everything inside it.

That is the property a `kill()` cannot give. `scripts/dev-lab.mjs` reaches for
`taskkill /T` and `session.ts` installs a `process.on('exit')` hook, and both are
right as far as they go — but every one of them is a *code path*, and the failure
that matters is the one where no code path runs at all.

A per-session job rather than putting the app itself in one: enrolling this
process would close the assignment window below entirely, since a child joins
its parent's job at `CreateProcess` — but it would also enrol every WebView2
helper Tauri spawns and make "kill the job" mean "kill the app".

### The adversarial results

Every row is `tasklist`, run externally, not the app's own opinion.

| Case | QEMU before | after | survivors |
|---|---|---|---|
| **10 consecutive start/stop cycles** (`--cycles 10`, 13 boots) | — | — | **0**, exit 0 |
| **Window closed while streaming** (real `WM_CLOSE` via `CloseMainWindow()`, app driven over CDP with a live session) | `[32496]` | `[]` | **0** |
| **Window closed mid-boot**, retry loop still running | `[6772]` | `[]` | **0** |
| **App hard-killed while holding a session** (`taskkill /F /PID <app>`, **no `/T`** — nothing of ours runs) | `[37880]` | `[]` | **0** |
| **App hard-killed mid-boot**, 1.2 s in | `[37312]` | `[]` | **0** |

### The negative control, because a check that always passes proves nothing

The same QEMU invocation, spawned by a parent with **no** job object, whose
parent then dies:

```text
Start-Process qemu-system-xtensa.exe ...    -> pid 23308
(parent exits)
tasklist  ->  "qemu-system-xtensa.exe","23308"   <- SURVIVOR, seen by the same check
```

So the enumeration used above does detect a leak when there is one.

A second, accidental control worth recording: the first attempt at this control
used Node's `child_process.spawn` and the child **died anyway** — libuv on
Windows already places non-detached children in a kill-on-close job. That is
worth knowing before anyone concludes from `dev-lab.mjs`'s behaviour that Node
leaves orphans; it is `Start-Process` and bare `CreateProcess` that do.

### The window that is not closed, stated rather than glossed

`CreateProcess` returns a running process and `AssignProcessToJobObject` runs
after it. For those microseconds the child is not yet in the job, and a hard kill
of this process inside that window would leave QEMU behind. Closing it needs
`CREATE_SUSPENDED` plus a resume, and `std::process::Command` returns no thread
handle to resume with — it would mean calling `CreateProcessW` here directly,
with its own command-line quoting, to cover a window that requires the app to
die within microseconds of a spawn. Not done; measured around instead (two of the
five rows above are kills timed into the boot).

## 6. Bytes arrive unframed and unmodified

Three independent pieces of evidence, because this is the one property the
parser downstream cannot check for itself.

**1. A deterministic unit test, no QEMU involved**
(`every_byte_the_socket_carried_reaches_the_sink_exactly_once`). A real
`TcpStream`, a hostile write pattern — single bytes through the banner, so the
flip from buffering to streaming lands mid-write, then a 40 KB block that forces
many reads — and the assertion that the concatenation of what the sink received
**equals** the concatenation of what the socket carried, byte for byte. Its
partner (`a_boot_without_a_banner_delivers_nothing`) asserts the other half: a
boot that panics delivers **nothing**, so a failed attempt's bytes can never
reach the parser and be read as telemetry from a session that does not exist.

**2. The pre-banner buffer really is flushed.** Boot is telemetry —
`@SESAME hello` and the `rest` face `setup()` ends with arrive *before* the
banner — so a consumer that only started receiving at the banner would miss the
boot. `session.ts` buffers events and replays them; Rust does the same one layer
lower, in bytes. `bannerOffset: 1749` with `sesameMarkersBeforeBanner: 3` in
every cycle is that assertion: three `@SESAME` markers, including the 1024-byte
OLED framebuffer, arrived before the banner and were handed over.

**3. Through the real IPC boundary, into a real webview.** Driven over CDP
against the running window (the same technique T2 used), with the app's own
`Channel` on the JavaScript side:

| | |
|---|---|
| `spawn_emulator` | booted, `attempts: [{attempt: 1, ok: true, ms: 1978}]` |
| byte channel | **213 chunks, 5,823 bytes**, `bannerAt: 1445`, 3 `@SESAME` before it |
| first 48 bytes | `@SESAME hello 1 sesame-fw-s2mini/0.1.0\n@SESAME f` |
| `hasQemuDiag` | **false** — QEMU's diagnostics stayed on the event channel |
| event channel | `{attempt: 1, diagnostic: 1, booted: 1}` |
| `emulator_status` | `{running: true, pid: 32496, port: 62079}` |
| `send_command('subtrim\n')` | `8` written; **the firmware answered on the byte channel** with `Subtrim values:` and all eight motors, 4,339 bytes |
| `send_command(400 bytes)` | `{kind: "writeTooLarge", bytes: 400, budget: 192}` |
| window closed | 0 survivors |

`subtrim` was chosen because it is `BARRIER_COMMAND` — read-only, it moves no
servo, and its reply is unmistakable. That single row exercises the whole loop:
JS → `invoke` → Rust → socket → firmware console → socket → `Channel` → JS.

## 7. How the origin is stamped, and what Rust refuses to invent

`SessionInfo.origin` carries the facts and only the facts:

```json
{ "kind": "emulator",
  "engine": "QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)",
  "machine": "esp32",
  "imagePath": "...\\images\\distro-v1-esp32-cli-oled.flash.bin",
  "imageName": "distro-v1-esp32-cli-oled.flash.bin",
  "qemuPath": "...\\qemu\\bin\\qemu-system-xtensa.exe" }
```

`engine` is read from the binary that is about to be spawned
(`qemu-system-xtensa --version`), not from a constant. `kind` is `"emulator"`
and there is no branch in this crate that produces any other value.

**What is deliberately absent: `elided`, `firmwareDeviations`, `board`, and
every capability boolean.** T2 §6.1 established that the capability record is
*derived from the image path* by frozen, tested objects in
`packages/sesame-qemu/src/config.ts` — `originForImage()`,
`capabilitiesForImage()`, `imageHasOledHook()`. A second hand-typed copy in Rust
is exactly the drift that would let the packaged app claim something the web app
does not. So Rust carries the identity across and the existing derivation
decides what it means.

This still preserves V7's property — *the origin claim comes from the backend,
not the app asserting it* — because the frontend cannot substitute a different
identity: `SpawnOptions` has no path fields, the paths come from
`resources::resolve`, and `imageName` is reported by the process that opened the
file. `isPhysicallyObserved()` stays false, because `kind` is `emulator` and
nothing here can produce anything else.

**For T4:** `resolveQemuOptions` is not reachable from the webview and neither is
`capabilitiesForImage` (T2 §6.1 — `config.ts` imports `node:path` and `node:url`
at module scope). Deciding how the webview gets the capability record from
`imageName` is T4's call and it is a decision, not an oversight. Rust has given
it the input; it must not be a second implementation.

## 8. Dependencies

**One crate, Windows-only:** `windows-sys = "0.61"` with `Win32_Foundation`,
`Win32_Security`, `Win32_System_JobObjects`, `Win32_System_Threading` — the four
features `CreateJobObjectW`'s own signature needs. It was already in
`Cargo.lock` three times over as a transitive dependency of tauri, wry and
tokio, so this adds a feature set rather than a crate.

Deliberately **not** added:

- **`regex`**, for four panic patterns. Three are string literals; the fourth is
  a literal with one hex run, hand-matched in 20 lines with a unit test that a
  `POWERON_RESET` is not a `SW_CPU_RESET`.
- **`tokio`** as a direct dependency. `tauri::async_runtime::spawn_blocking`
  runs on tauri's own runtime; a second one would be a second scheduler.
- **Frontend dependencies: none.** T3 touches no JavaScript at all.

## 9. What did not change

- **1,058 tests passing + 1 skipped**, byte-identical to T2's count. Nothing in
  `apps/web/`, `packages/`, `emulator/`, `firmware/`, `hardware/` or
  `reference/` was touched — `git status` is `justfile`, `src-tauri/*` and this
  file.
- **11 validators green**, `just validate` exit 0.
- **Rust: 30 tests** (up from 4), `cargo clippy --all-targets -- -D warnings`
  clean, `cargo fmt --check` clean.
- `just dev`, `just dev-sim`, `just run`, `scripts/dev-lab.mjs`,
  `apps/web/server/lab-host.mjs`: untouched.
- T1's seam (`TAURI_EMULATOR_BACKEND` is still `null`, `detectDesktopShell`,
  the fifth `labHost: 'desktop'` state) and T2's `resources.rs`,
  `resource_report` and `--resource-report`: untouched. **The desktop app still
  opens on the behavioural simulator and still says so** — flipping that is T4's
  one-constant change, and doing it here would have shipped a window whose
  status line named an emulator no code had selected.
- `justfile` gained one recipe, `tauri-emulator`. `tauri-resources` unchanged.

## 10. Awkward things, named

- **The mask ROM's first line is a race, not a property.** QEMU's
  `-serial tcp:...,server=on,wait=off` starts the machine immediately and
  discards output while no client is attached, so whether `ets Jul 29 2019` /
  `rst:0x1 (POWERON_RESET)` survives depends on how fast the poll-connect wins.
  Measured: the **release** build wins it (banner at offset 1749, ROM line
  present); the **debug** build does not (offset 1445, ROM line absent). Same
  code, ~300 bytes of difference. `session.ts` attaches the same way and
  inherits the same race, so this is not new — but it is reported rather than
  asserted, because asserting it would make the selftest fail on slow machines
  for a reason that has nothing to do with the supervisor.
- **`send_command` does not wait for anything.** It writes and returns the byte
  count. Every completion guarantee this project has — the barrier, the face
  settle, the command timeout — is expressed in parsed events and is T4's.
  A T4 that fires commands without fencing them will see the interleaving
  `session.ts`'s `runCliLines` exists to prevent.
- **Two channel arguments is a slightly awkward call site.** The alternative was
  one tagged channel with base64 payloads, which would have put an encoding
  between the socket and the parser — the one thing this workstream must not do.
- **The selftest cannot be a `cargo test`.** It needs a real `tauri::App` to
  resolve `BaseDirectory::Resource`, and the whole point is to run against the
  *built* executable in its installed layout. It is a flag on the binary, like
  T2's, and `just tauri-emulator` is how it is run.
- **A clean clone still cannot run it.** T2 §8 already said `tools/` and
  `emulator/qemu/images/` are gitignored; `--emulator-selftest` on such a build
  fails with `artifactMissing` on attempt 1 and does not retry — correct, but T6
  should say `node emulator/qemu/fetch-qemu.mjs` and `just qemu-image` out loud.
- **`csp: null` is still `csp: null`.** T1 deferred it, T2 did not touch it, T3
  did not touch it. It is still the loosest setting in the config and it is now
  in front of a webview that can spawn a process.
