---
task: "T4 — TauriSesameRobot and the contract suite"
phase: 5
status: complete
date: 2026-09-05
owns: apps/web, packages/sesame-qemu (the capability split only), src-tauri (one test-only flag), justfile, docs/findings
plan: docs/plans/phase-5-tauri-desktop-app.md §4 (option C), §5 T4
follows: docs/findings/T3-rust-supervisor.md §7, §10
---

# T4 — the desktop window drives real firmware, and passes the same fifteen cases

**Done when:** `describeRobotContract` passes against `TauriSesameRobot`, all
fifteen cases, unweakened, as one additional call. **It does** — §4 is the run,
case by case, against real firmware booting in the shipped Rust supervisor.

The seam T1 left is flipped, T3's two loose ends are tied, and every honesty
surface was read out of the **packaged** window (`http://tauri.localhost/`,
embedded assets, bundled QEMU) rather than reasoned about — §6.

`docs/findings/` is gitignored but tracked files inside it still commit. This
file needs `git add -f`.

---

## 1. The shape, and where each piece already existed

```text
a button in the Tauri window
  encodeCommand()                 @sesame-lab/sesame-protocol      UNCHANGED
  + BARRIER_COMMAND, one write    TauriSesameRobot.#write()        NEW (§3)
  invoke('send_command', bytes)   T3                               UNCHANGED
  ──────────────────────────────  the process and the socket ──────────────
  real Xtensa instructions on an emulated ESP32
  ──────────────────────────────  raw bytes back on a Channel ─────────────
  SesameTelemetryParser           @sesame-lab/sesame-protocol      UNCHANGED
  TauriSesameRobot.#absorb()      mirrors QemuSesameRobot          NEW
  TauriBackend                    mirrors QemuBackend              NEW
  TelemetryStore -> the scene, the OLED, the lessons               UNCHANGED
```

Four new files, all under `apps/web/src/backends/tauri/`:

| | lines | |
|---|---:|---|
| `supervisor.ts` | 240 | T3's four commands as an interface, plus the IPC implementation |
| `robot.ts` | 620 | `TauriSesameRobot implements SesameRobot` |
| `backend.ts` | 300 | `TauriBackend implements TelemetryBackend` |
| `__tests__/support/stdio-supervisor.ts` | 240 | the contract suite's transport, **not shipped** |

**The parser is the existing one, constructed and not reimplemented.** Bytes
arrive as an `ArrayBuffer` from `Channel<Response>` and go straight into
`SesameTelemetryParser.push()`, which already accepts `ArrayBuffer`. Nothing
decodes, re-frames or re-chunks them on the way, which is the whole reason
option C was chosen: the parser's invariant — *output depends only on the
concatenated byte stream, never on chunking* — was proven across ~1,500 split
offsets and is not re-earned here, it is reused.

`robot.ts` is written against `packages/sesame-qemu/src/robot.ts` deliberately
line for line: the absorb loop, `getState()` as a report rather than a model,
`everObserved`, the face settle, the serialised command queue, the two
documented CLI divergences. The two backends have to pass the same fifteen
cases and a second design would have been a second set of bugs.

### One thing that had to be new, and it was a bug

`QemuSesameRobot` gets a fresh `QemuSession` object per boot attempt, so a
failed attempt's state is discarded with the object. Here the robot outlives
Rust's retry loop, so `guestPanic` and `exited` for **abandoned** attempts
arrive on the same event channel as the surviving session's. Recording them left
a perfectly healthy emulator permanently holding a panic from a guest that no
longer existed.

Four contract cases failed with *"the guest panicked: Guru Meditation Error"*
against an emulator that had booted fine on its third attempt. The rule is now
explicit and unit-tested: **nothing before `spawn()` resolves describes the
session that survived.** Roughly a quarter of cold boots panic
(ISSUE-20260823-022), so this was not an edge case — it was most runs.

## 2. The capability derivation — split, not copied

T3 §7 left this open, and T2 §5 had already shown which way it can fail:

```ts
export function imageHasOledHook(imagePath: string): boolean {
  return basename(imagePath).includes('cli-oled');
}
```

An unrecognised name gets the **conservative** answer — `oledFramebuffer: false`,
`ssd1306-panel` back on the elision list — so a second copy of the table would
downgrade the OLED claim from `observed` to elided *silently, in the
safe-looking direction*. One rename is all it takes.

So `packages/sesame-qemu/src/config.ts` was **split**, not duplicated:

| `capabilities.ts` (new, pure) | `config.ts` (unchanged behaviour) |
|---|---|
| `QEMU_ORIGIN`, `QEMU_ORIGIN_WITHOUT_OLED`, `originForImage` | `REPO_ROOT`, `DEFAULT_QEMU_PATH`, `DEFAULT_IMAGE_PATH` |
| `QEMU_CAPABILITIES*`, `capabilitiesForImage` | `resolveQemuOptions`, `QemuRobotOptions` |
| `ELIDED_*`, `FIRMWARE_DEVIATIONS`, `PERIPHERAL_FIDELITY` | the `node:path` / `node:url` half |
| `imageHasOledHook`, `POWER_ON_ANGLE_DEG` | `export * from './capabilities.js'` |

`config.ts` re-exports every symbol, so `index.ts`, `robot.ts`, `session.ts`,
`cli.ts` and every existing importer are untouched and the package's public
surface is identical. The new `@sesame-lab/sesame-qemu/capabilities` subpath is
the only addition, and it resolves the pure module without `config.ts` and
therefore without Node.

**The one edit inside the moved code** is `path.basename()` → four lines of
string handling, because `node:path` is the import the file exists to avoid. It
is *stricter* than the POSIX shim a bundler would otherwise substitute — that
one returns the whole string for a Windows path, which T2 noted only happens to
still work.

`@sesame-lab/sesame-qemu` moved from `devDependencies` to `dependencies` in
`apps/web`. That is a reclassification of a workspace package that was already
there, not a new dependency; **zero npm packages were added**, and
`@tauri-apps/api` was not needed either — `withGlobalTauri` is `true`, so
`window.__TAURI__.core` carries both `invoke` and `Channel`, which is the same
choice T2's `resource-report.ts` made. The built bundle was checked rather than
assumed: **zero occurrences of `node:child_process`, `node:path` or
`fileURLToPath`**, and `distro-v1-esp32` present.

## 3. The barrier protocol, rebuilt where it can live

T3 §10: *"`send_command` does not wait for anything. It writes and returns the
byte count."* Fencing needs the parser, and the parser is in the webview, so the
fence is in `TauriSesameRobot.#write()` — assembled from the same three protocol
constants `session.ts` uses, and no others:

1. the lines and `BARRIER_COMMAND` (`subtrim`) go out in **one** write, so the
   firmware never sees a gap it could interleave something into;
2. the console reads one character per `loop()` and runs a completed line
   synchronously inside that iteration (`sesame-firmware-main.ino:788`), so a
   read-only command queued behind a movement cannot be dispatched until the
   movement has fully returned;
3. `BARRIER_MARKER` (`Subtrim values:`) is counted **as it comes back out of the
   parser** — a `log` event, not a byte scan — and the write resolves when the
   count moves.

No polling of the robot, no fixed sleep, no guess about how fast QEMU is running
today. `commandTimeoutMs` (90 s), `faceSettleMs` (1200) and `faceSettleMaxMs`
(3000) came across with their reasons; `POWER_ON_ANGLE_DEG` came across from the
capability module. The unit tests assert the fence directly: a `command('wave')`
that is still pending after the servo events have landed, and resolves on the
barrier — *the choreography being visible is not the choreography being over*.

The 192-byte budget is checked here **and** in Rust. The local check exists to
attach the reason (arduino-esp32's 256-byte ring buffer, drained one character
per `loop()`, overflowing silently); Rust is the backstop. The live number is
read off `SessionInfo.maxWriteBytes` rather than hard-coded, so if the two ever
disagree the wire's own number wins.

## 4. The contract — fifteen cases, unweakened, and what is on the other end

```text
apps/web/src/__tests__/tauri-contract.test.ts   ← one call, nothing else in it
```

Nothing in `packages/sesame-api/src/contract/` changed. The file is the same
shape as `packages/sesame-qemu/src/__tests__/contract.test.ts`; only the factory
differs, because the factory is the suite's only injection point.

```text
✓ C01 stand reaches the eight expected joint targets                     6975ms
✓ C02 wave begins with the expected sequence                             5786ms
✓ C03 setFace("rest") makes the face state rest                          4182ms
✓ C04 setFace("stand") emits nothing — ISSUE-20260823-004 reproduced     5285ms
✓ C05 an invalid command does not move the robot                         3689ms
✓ C06 getState returns a canonical RobotState                            3936ms
✓ C07 GET /api/status returns the firmware key set                       5600ms
✓ C08 POST /api/command runs a movement, and answers before it finishes  9497ms
✓ C09 /api/status reports a face that is not on screen after stand       2491ms
✓ C10 every route answers any verb, and only two check the method        2063ms
✓ C11 unmatched paths: JSON 404 under /api/, portal 200 everywhere else  1851ms
✓ C12 an argument with no "=" does not exist                             3715ms
✓ C13 hostile face and command names are sanitised at the boundary       9321ms
✓ C14 the server binds loopback by default, refuses a remote bind        1885ms
✓ C15 the settings round-trip survives                                   1897ms

Tests  15 passed (15)   Duration 68.89s
```

**No case failed and no case was adjusted.** Thirty boots across two runs left
**zero** `qemu-system-xtensa.exe` and zero `sesame-lab-desktop.exe` behind,
checked with `Get-Process` rather than with the harness's own bookkeeping.

### The awkward part: the suite is Node code and the robot lives in a webview

`describeRobotContract` imports `node:assert/strict`, and **C14 constructs a
real `SesameApiServer` and calls `listen()`**. There is no arrangement in which
those fifteen cases run inside WebView2. So the suite runs where it has always
run, and the question is what `TauriSesameRobot` talks to there. Three answers,
two of them worse:

1. **A fake supervisor** — worthless. C01 and C02 assert the firmware's own
   choreography; a suite that passed against a stub would be measuring the stub.
2. **A second supervisor in Node**, spawning QEMU with `child_process`. That is
   a second implementation of what T3 built — the exact drift T3 §7 refused for
   the capability record — and it would prove nothing about the Rust that ships.
3. **`sesame-lab-desktop.exe --supervisor-stdio`** — the shipped binary,
   `app.path()`-resolved paths, the bundled QEMU, `launch_with_retry`'s twelve
   attempts, `Session::write`'s budget, the job-object teardown. Only the
   *carrier* differs: an IPC `Channel` in the window, a pipe here.

That is the one addition to `src-tauri/` (`src/stdio.rs`, ~330 lines including
tests), and it follows the precedent T2 and T3 both set — `--resource-report`,
`--emulator-selftest` — that a property which fails on somebody else's machine
gets a flag rather than a screenshot. It is not reachable from the app: it needs
a command-line flag the window never passes, and it is the only thing in the
crate that reads stdin.

The frame is `[u8 kind][u32 LE length][payload]`, kind 0 for UART bytes and kind
1 for JSON, so the byte stream stays **byte-identical** — a Rust unit test
round-trips a payload containing every value 0..=255 plus newlines and a
`@SESAME` marker. base64 would have put an encoding between the socket and the
parser, which is the one thing this workstream must not do. QEMU's own
stdout/stderr still travels as a `diagnostic` event and never as kind 0, so
T3 §2's honesty rule survives the change of carrier.

### And 22 cases that need no emulator

`apps/web/src/__tests__/tauri-robot.test.ts` asserts, against a fake transport,
the things the contract cannot reach on a clone with no cargo and no QEMU: the
pre-boot byte replay, the fence, the budget, the origin composition, the
capability derivation in both directions, `isPhysicallyObserved()` false on
every event, *diagnostics are never telemetry*, and the abandoned-attempt panic
rule from §1. The contract suite skips **loudly** without a build, naming the
command — the same discipline `packages/sesame-qemu`'s `helpers.ts` uses,
because a contract suite that reports success without executing is worse than
one that fails.

## 5. What the seam flip actually did

```ts
export const TAURI_EMULATOR_BACKEND: BackendId | null = 'qemu';   // was null
```

T1 designed one constant and it behaved as designed — `selectsSimulator` went
false, `initialBackend()` returned the emulator, `desktopSimulatorProbe()`
stopped being reached and its line stopped rendering. **Verified in the window
rather than assumed**: `panel-desktop-simulator` is absent and the status line
reads `SYSTEM: QEMU EMULATOR` where T1's screenshot read `SYSTEM: HOST MODEL`.

Two things it did **not** do on its own, both found by running it:

1. **The `/lab/session` probe came back to life.** `App.tsx` skipped it on
   `desktop.selectsSimulator`, which goes false the moment the constant names a
   backend — so the packaged app started probing an origin that does not exist,
   4xx'ing against `tauri://`, landing on `labHost: 'absent'` and rendering
   *"No lab host on this origin — how to start one"* over a perfectly good
   emulator. The gate is now `desktop.present`.
2. **Something has to build the backend.** `'qemu'` is the same `BackendId` the
   browser path uses, deliberately: what is behind the wire is identical, and
   only the owner of the process differs. So the `switch` arm is
   `desktop.present ? new TauriBackend() : new QemuBackend({ baseUrl })` — one
   line, next to the others. A fourth id would have meant teaching the rail, the
   trace panel and W8's default about a distinction the reader does not have.

`desktopSimulatorProbe()` and its branch were kept rather than deleted. Setting
the constant back to `null` restores the announced simulator exactly, and
`desktop-simulator.test.ts` asserts that both directions still work — deleting
it would have made "a desktop build with no emulator" silently
indistinguishable from "an emulator that has gone quiet".

## 6. The honesty surfaces, read out of the packaged window

`pnpm exec tauri build`, then the release executable launched with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` and driven over
CDP. **`CDP target: http://tauri.localhost/`** — embedded assets, not a Vite dev
server. (An earlier pass accidentally proved the difference: a plain
`cargo build --release` has no `custom-protocol` feature and loaded `devUrl`
instead. Worth knowing before anyone verifies a packaging property against a
binary that is not packaged.)

| Surface | In the packaged window |
|---|---|
| status line | `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE` |
| trust panel | `PHYSICAL HARDWARE: NONE` |
| provenance badge | `observed` / `emulated (QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417), distro-v1-esp32)` |
| `measurementVerdict()` | *"Not a measurement. The firmware really executed and really wrote these angles, but it did so on emulated silicon…"* |
| board | `distro-v1-esp32 — the legacy V1 board. Not the S2 Mini in this project's pin diagram.` |
| `isPhysicallyObserved()` | **`0 physically observed`** at 32 events |
| backend | `qemu`, `mode: 'qemu'`, `origin.kind: 'emulator'` |
| `panel-desktop-simulator` | **absent** — T1's line is gone |
| `panel-no-lab-host` | **absent** |
| elided | `wifi-mac … ssd1306-glass … ledc-waveform, usb-cdc` — glass elided, panel not |
| OLED pane | `state: observed`, *"These pixels came from the emulator — the buffer the firmware drew."*, `fromEmulator: true`, **571 lit pixels**, `projectedIn3d: true` |
| `lastCommandLine` | `rn wv` |
| boot | `real firmware executing under QEMU · booted in 2177 ms after 1 attempt(s)` |

Before the `wave` the same window read `nothing yet` / `origin not stated` /
*"Nothing has driven this scene yet."* / `PHYSICAL HARDWARE: NONE` — the state
where nothing has happened is still as careful as the state where something has.

After the `wave`: all eight `everObserved` true, the scene graph moved
(`R1` q = `[0, −0.0872, 0, 0.9962]`, `sceneCommandedDeg: 100`), every joint
`storeProvenance: observed` with `storeOriginKind: emulator` and
`storePhysicallyObserved: false`. **A real `runWavePose` executed in emulated
Xtensa and moved the robot in a packaged desktop window.**

Window closed with `CloseMainWindow()`: **0 `qemu-system-xtensa.exe` survivors**.

### The retry is visible

An earlier run of the same script booted on the third attempt and the window
said so, live, off T3's `attempt` / `attemptFailed` events:

> `real firmware executing under QEMU · booted in 2371 ms after 3 attempt(s) · 2
> boot(s) panicked and were relaunched — ISSUE-20260823-022, a QEMU
> cache-modelling bug this retries past rather than fixes`

`status.attempts` reached 3 **while the boot was still running**, not
reconstructed from the attempt log afterwards. That is what the event channel is
for, and a silent multi-second freeze reads as a hang.

### Origin: Rust's facts joined to the frozen record

`kind`, `board`, `elided` and `firmwareDeviations` come from `originForImage()`,
the derivation keyed off the image path. `engine` is **overridden with what Rust
read out of the binary it spawned** (`qemu-system-xtensa --version`), because
the derived value is a constant pinned to `QEMU_RELEASE` and the measured one is
a fact about the process that ran. The app cannot substitute a different
identity — `SpawnOptions` has no path fields, the paths come from
`resources::resolve`, and `imageName` is reported by the process that opened the
file. V7's property, preserved without HTTP.

## 7. What did not translate from `robot.ts`

- **`launchWithRetry` and `QemuSession`.** They are the process and the socket;
  they are Rust's, and that is the point of the split.
- **`session.history`.** There is no event buffer to replay because there are no
  events yet — Rust flushes the pre-banner **bytes**, one layer lower, and the
  parser is created in the same tick that drains them. The consequence is real:
  bytes can arrive before `spawn_emulator` resolves (they routinely do), and the
  origin is not known until it does, so `#queued` holds them. The parser's
  chunk-invariance is what makes that free.
- **The error classes.** `QemuNotConnectedError` and friends live in
  `packages/sesame-qemu/src/errors.ts`, reachable only through a module that
  imports `node:child_process`. `robot.ts` declares four structurally identical
  ones with the same messages. A third pure subpath export for five error
  classes was not worth the surface; the contract does not branch on error type
  (C05 accepts either rejecting or accepting an unknown word), and the *wire*
  errors from Rust arrive with `name` set to the `kind` tag either way.
- **`QemuRobotState`.** Redeclared as `TauriRobotState` for the same reason,
  with an identical `observed` block.
- **`get options` / `get session`.** `ResolvedQemuOptions` does not exist here —
  the frontend does not resolve options, Rust does — so `session` returns the
  `SessionInfo` Rust reported instead, which carries the argv, the attempt log
  and the origin facts.
- **`bootAttempts` survives a failed connect only partially.** `QemuSesameRobot`
  keeps the attempt log off `QemuBootFailedError` when *every* attempt failed.
  Here a total failure rejects with Rust's `bootFailed`, which carries
  `attempts` and `reasons` but is not unpacked into `robot.bootAttempts` — the
  count reaches the UI through `status.attempts`, which the event channel has
  been updating throughout. Stated rather than fixed: the number a user sees is
  correct, the getter is empty.

## 8. What did not change

- **`just dev`, `just dev-sim`, `just run`, `scripts/dev-lab.mjs`,
  `apps/web/server/lab-host.mjs`, `QemuBackend`, `vite.config.ts`:** untouched.
  **The web path still uses the HTTP lab host.**
- **`hardware/`, `emulator/`, `firmware/`, `reference/`:** not touched.
- **Tests: 1,096 passing + 1 skipped**, up from T3's 1,058 + 1. The 38 new ones
  are 15 contract cases, 22 unit cases and one seam case; **nothing existing was
  removed**, and the only existing test modified is
  `desktop-simulator.test.ts`, whose T1 assertion *"T1 really does ship with no
  emulator backend"* is now *"T4 ships one"* — which is the assertion T1 wrote
  the seam to make possible.
- `packages/sesame-qemu`'s own 48 tests, including its own fifteen contract
  cases, pass unmodified after the `config.ts` split.
- **11 validators green.** **Rust: 33 tests** (up from 30),
  `cargo clippy --all-targets -- -D warnings` clean, `cargo fmt --check` clean.
- **T3's invariants re-checked on the rebuilt release binary**
  (`--emulator-selftest --cycles 2`, which ran 3 boots): `ok: true`,
  `survivors: []`, banner in every stream, `qemuDiagnosticsInStream: false`.
- **Frontend dependencies: none added.** `@sesame-lab/sesame-qemu` moved
  dev → prod within the workspace; `@tauri-apps/api` was not needed.
- `justfile` gained `tauri-contract` and two corrected comments.

## 9. Awkward things, named

- **`pnpm test` is now ~70 s slower once `src-tauri` has been built**, because
  the contract boots fifteen emulators. That is the same bargain
  `packages/sesame-qemu` already made (its own suite is 54 s) and it is gated on
  the binary existing, so a clone without cargo pays nothing. `just
  tauri-contract` runs it alone.
- **The contract's transport is a pipe, not the app's IPC channel.** Everything
  below the pipe is the shipped supervisor, and the framing is a bare length
  prefix with a byte-identity test — but the `Channel` path itself is exercised
  by §6's CDP run and by T3 §6.3, not by the contract. Two carriers over one
  supervisor is the honest description.
- **`findDesktopExe()` picks the newest profile, not release.** A stale
  `release/` from before this workstream has no `--supervisor-stdio`: it would
  open a window and never answer, so the suite would *hang* rather than fail.
  Newest-by-mtime is a heuristic covering a real failure I hit.
- **A plain `cargo build --release` is not a packaged build.** Without
  `tauri build`'s feature set it serves `devUrl`, so it will silently use
  whatever is on `:5173`. §6 was re-run against the real artifact after
  discovering this; anyone verifying a packaging property should check the CDP
  target URL says `tauri.localhost`.
- **A stray Vite dev server was holding `:5173` on this machine** for the whole
  session — left over from an earlier `tauri dev`. `pnpm dev` now pins
  `strictPort`, so a second one would fail loudly, but a *stale* one does not:
  it answers, and the window shows an old build. Not killed, because it is not
  this workstream's process.
- **`origin` before a session exists is the conservative one.** With no
  `imagePath` yet, `originForImage('')` returns `QEMU_ORIGIN_WITHOUT_OLED` and
  `capabilitiesForImage('')` reports `oledFramebuffer: false`. That is the safe
  direction — during boot the pane under-claims rather than promising pixels —
  and `emulatorFacts().mode` is `null` until the emulator is actually up, so
  nothing names a machine that does not exist yet.
- **`csp: null` is still `csp: null`.** T1 deferred it, T2 and T3 did not touch
  it, and T4 has now put a webview that can spawn a process *and command real
  firmware* behind it. It is the loosest setting in the config and T6 should not
  inherit it silently.
- **My working tree was committed mid-task by a concurrent agent.** The
  licensing sweep (`5c864fe`, "Licensing for public release…") swept the
  in-progress T4 files into its commit at 07:16. Nothing of T4's was removed and
  everything below still passes, but T4 did **not** run `git commit` and the
  history does not describe this workstream.
