---
task: "T2 — resource bundling"
phase: 5
status: complete
date: 2026-09-02
owns: src-tauri, justfile, apps/web (the resource-report surface only)
plan: docs/plans/phase-5-tauri-desktop-app.md §5 T2
follows: docs/findings/T1-tauri-scaffold.md
---

# T2 — the files are in the app, and the app can prove it

**Done when:** *a built `.exe` on a machine with no repo checkout can locate
every resource, verified by running it from a directory that contains nothing
else.* It does. §4 is that test, run literally: the NSIS installer into a fresh
empty directory, the repository nowhere on any path, the working directory set
to somewhere unrelated, exit code 0, **13 of 13 resources at exactly the byte
sizes the bundler was given**.

`docs/findings/` is gitignored but tracked files inside it still commit, exactly
as every finding before it did. This file is meant to be committed and needs
`git add -f`.

---

## 1. What ships, itemised and measured

Thirteen files, enumerated one by one in `bundle.resources`. Not a glob and not
a directory — see §3 for why that is a decision rather than verbosity.

| In the bundle | Bytes | |
|---|---:|---|
| `qemu/bin/qemu-system-xtensa.exe` | 71,749,689 | one copy; `…xtensaw.exe` is byte-identical and does **not** ship |
| `qemu/share/qemu/esp32-v3-rom.bin` | 455,722 | |
| `qemu/share/qemu/esp32-v3-rom-app.bin` | 455,722 | |
| `qemu/share/qemu/esp32c3-rom.bin` | 393,216 | see the note below |
| `qemu/share/qemu/esp32s3_rev0_rom.bin` | 393,216 | see the note below |
| `images/distro-v1-esp32-cli-oled.flash.bin` | 4,194,304 | the current `DEFAULT_IMAGE_PATH`; the other four images do not ship |
| `hardware/` — 7 JSON artefacts | 1,456,986 | hardware-map 310 KB, lessons 340 KB, assets-inventory 281 KB, joint-map 194 KB, source-annotations 182 KB, calibration 79 KB, assembly-map 71 KB |
| **resources total** | **79,098,855** | 75.4 MiB |
| `sesame-lab-desktop.exe` | 9,753,088 | Tauri runtime + `apps/web/dist` (3.8 MB), embedded, not a resource |
| **installed payload** | **88,851,943** | **84.7 MiB** |

Installers: **MSI 31.0 MB**, **NSIS 21.9 MB**. §3 of the plan predicted "≈ 83 MB
+ the Tauri runtime"; the measured 84.7 MiB installed is that number, and
nothing unexpected got in.

**The two ROMs that are not for our machine.** `esp32c3-rom.bin` and
`esp32s3_rev0_rom.bin` are 786 KB we never load: this app boots
`-machine esp32` and nothing else, and `QEMU_CAPABILITIES_FULL.unsupportedBoards`
records that the S3 image reaches the bootloader and never `setup()`, and that
there is no `esp32s2` machine at all. They ship anyway, because `share/qemu/` is
QEMU's own data directory and a *partial* copy of it is a thing somebody later
has to reason about. 786 KB out of 84.7 MB is not worth an asterisk on a
directory that otherwise means "the QEMU install, as installed".

**`firmware/upstream/` still ships nothing, and this was checked rather than
assumed.** The `tauri build` transcript emits
`dist/upstream/firmware/{captive-portal.h, face-bitmaps.h, movement-sequences.h,
sesame-firmware-main.ino}` — 385 KB, the four annotated files, published by
`serveUpstreamSource()` in `apps/web/vite.config.ts` after it verifies each
SHA-256 against `hardware/source-annotations.json`. They are inside
`frontendDist` and therefore inside the executable. The 221 MB tree is not in
`bundle.resources` and does not appear anywhere in the built tree.

## 2. The rule, and where it is enforced

**`app.path()` only.** `src-tauri/src/resources.rs` is the only place in the
desktop shell that turns a resource name into a path, and it does it exactly
once:

```rust
manager.path().resolve(&relative, BaseDirectory::Resource)
```

There is no `CARGO_MANIFEST_DIR`, no walk up from the executable, no path
relative to the working directory anywhere in `src-tauri/`. The reason this is
worth a section is that the wrong version of it *works* — in `tauri dev`, in
`cargo run`, on the machine that built it — and fails for the first time on the
machine the app was built for.

For contrast, and as a note for T3: `packages/sesame-qemu/src/config.ts`
computes `REPO_ROOT` from `import.meta.url` and hangs `DEFAULT_QEMU_PATH` and
`DEFAULT_IMAGE_PATH` off it. That is correct for a Node process inside a
checkout and **meaningless inside an installed `.exe`**, where there is no
checkout. T3 must pass explicit paths — see §6.

### `\\?\`

`app.path().resolve()` answers with an extended-length ("verbatim") Windows
path. It is a correct path and Rust opens it happily, but T3 puts one of these
inside a QEMU `-drive file=<image>` argument and the other into
`Command::new`, and the prefix is a red herring in every diagnostic downstream.
`dunce::simplified()` strips it only where the shorter form is provably the same
path. `dunce` was already in `Cargo.lock` as a transitive dependency of `tauri`,
so this cost nothing to compile.

## 3. What actually lands in the bundle, versus what you would expect to

This is the part that had to be read out of `tauri-utils` rather than guessed,
because two plausible configurations produce a bundle that installs cleanly and
is wrong.

### The list form would have put everything under `_up_/`

`tauri_utils::resources::resource_relpath` maps each path component to a bundle
location, and it maps `Component::ParentDir` to a literal directory named
`_up_`. With the **array** form, `"../tools/qemu/qemu/bin/qemu-system-xtensa.exe"`
lands at `$RESOURCE/_up_/tools/qemu/qemu/bin/qemu-system-xtensa.exe`. Every
resource in this app is outside `src-tauri/` — T1 §1 put `src-tauri/` at the
repo root precisely so those paths would be one `..` and legible — so the array
form was never viable. `build.rs` panics with that explanation if anyone changes
`resources` to a list.

### A trailing slash on a single-file target produces a file named after the directory

In the **map** form, for a source that is one file and not a glob,
`resources.rs` uses `dest.clone()` — the target string is the complete
destination path, not a directory to drop the file into. So
`{"../x/qemu.exe": "qemu/bin/"}` produces `$RESOURCE/qemu/bin`, *a file called
`bin`*. Tauri's own source calls the empty-string case "a confusing special
case" and marks it for removal in v3. Every target here is a full path including
the file name, and `build.rs` asserts it.

### So the resource tree was listed rather than trusted

`src-tauri/target/release/`, after `tauri build`, and the installed tree after
the NSIS installer ran — identical, 13 files, no `_up_`, no extras:

```text
qemu/bin/qemu-system-xtensa.exe          71749689
qemu/share/qemu/esp32-v3-rom-app.bin       455722
qemu/share/qemu/esp32-v3-rom.bin           455722
qemu/share/qemu/esp32c3-rom.bin            393216
qemu/share/qemu/esp32s3_rev0_rom.bin       393216
images/distro-v1-esp32-cli-oled.flash.bin 4194304
hardware/{7 files}.json                   1456986
```

### `bin/` and `share/qemu/` keep their relative offset on purpose

QEMU finds its own data directory with `os_find_datadir()`, which looks for
`../share/qemu` next to the executable. Flattening the two into one resource
directory would have built fine, installed fine, and then failed at boot with
*"Could not open option rom"* — a failure T3 would have had to diagnose from
scratch, in the one place where "it works in dev" is least helpful.

### The manifest is generated from the config, not typed beside it

`build.rs` reads `bundle.resources` out of `tauri.conf.json` and writes
`resource_manifest.rs`. A hand-written list beside a config list is two lists,
and the drift is silent in the direction that matters: a resource dropped from
the config keeps being *reported present* by a stale manifest, and the report —
whose entire job is to be the thing T3 and T6 check instead of trusting the
bundle — starts lying. Deriving one from the other makes that unrepresentable.

`expected_bytes` is `metadata(source).len()` measured **at build time** rather
than a constant, because `build-qemu-images.mjs` and `build-lessons.mjs`
regenerate their artefacts and a stale constant cries wolf. Measured at build
time it answers the question actually worth asking of a packaged app: *is the
file next to the exe the file that was configured, whole?*

## 4. The acceptance test, run literally

```powershell
"Sesame Lab_0.1.0_x64-setup.exe" /S /D=<a directory that did not exist>
```

The installer created a directory containing the executable, its uninstaller and
the 13 resources — nothing else, no repository, no `node_modules`, no `tools/`.
Then, with the working directory set to somewhere unrelated:

```powershell
sesame-lab-desktop.exe --resource-report <out.json>
```

```text
exit code: 0
ok=True  present=13/13  bytes=79098855  (75.4 MiB)
resourceDir=...\t2-install
  OK   71749689  ...\t2-install\qemu\bin\qemu-system-xtensa.exe
  OK    4194304  ...\t2-install\images\distro-v1-esp32-cli-oled.flash.bin
  ... 11 more, every one at its expected size
```

### The negative control, because a check that always passes proves nothing

One ROM deleted and the flash image truncated to 9 bytes, in the installed copy:

```text
exit code: 1
ok=False  present=12/13
  BAD images/distro-v1-esp32-cli-oled.flash.bin: 9 bytes, but ... was 4194304 bytes
     when this build was made. A resource that is present at the wrong size is
     worse than one that is absent: nothing downstream will notice.
  BAD qemu/share/qemu/esp32-v3-rom.bin: not found. It was configured as
     ../tools/qemu/qemu/share/qemu/esp32-v3-rom.bin in bundle.resources; ...
```

Both restored, and the test install silently uninstalled afterwards — no
registry entry and no directory left on this machine.

### Why there is a flag at all

Verifying this by opening the window and reading a panel is verification by
screenshot, which this project does not accept anywhere else and should not
start accepting for the one property that fails on somebody else's machine.
`--resource-report [path]` writes the same document the webview gets and exits
**1** if anything is missing or the wrong size. It suppresses the window rather
than opening and closing one — Tauri creates `app.windows` inside `build()`,
before anything else runs, so `window.create = false` on the mutated context is
the only way not to flash a WebView2 window at whoever is running the check.

`just tauri-resources` is that command; `just tauri-resources debug` checks a
plain `cargo build`.

### And in the running window, in the packaged app

Driven over CDP against the **installed** executable (WebView2 with
`--remote-debugging-port`), not the dev build:

| | |
|---|---|
| `window.__TAURI__.core.invoke('resource_report')` | `{ok: true, total: 13, present: 13, bytes: 79098855}` |
| `window.__sesame.resourceReport()` | same |
| `[data-testid="desktop-resources"]` | `13 bundled resources resolved, 75.4 MiB` |

That closes the one link the CLI flag cannot: an app-defined command **is**
reachable with nothing but `core:default` in `capabilities/default.json` —
v2's permission system gates plugin commands, not the app's own — and
`generate_handler!` registration and the command name are correct in a packaged
build, not merely in a unit test.

The same run re-read T1's surfaces out of the packaged window, because T5 exists
on the premise that packaging is where they get quietly lost:
`PHYSICAL HARDWARE: NONE`, *"Nothing has driven this scene yet."*,
`panel-desktop-simulator` present, `panel-no-lab-host` **absent**, backend
`sim`, `physicallyObservedEvents: 0`. Unchanged.

## 5. The image path still classifies correctly — checked, not assumed

This was the cheap correctness bug available here, and it is worth stating
exactly how narrow the escape was.

`capabilitiesForImage()` decides `oledFramebuffer` — and therefore whether the
OLED pane may claim `observed` pixels rather than `inferred`/elided — with:

```ts
export function imageHasOledHook(imagePath: string): boolean {
  return path.basename(imagePath).includes('cli-oled');
}
```

An unrecognised name gets the **conservative** answer: `false`, `ssd1306-panel`
back on the elision list, `QEMU_ORIGIN_WITHOUT_OLED`. Safe, and wrong — the
image really does have the hook, and the app would under-claim a capability it
has. Run against a plausible installed path:

```text
C:\Users\nephew\AppData\Local\Sesame Lab\images\distro-v1-esp32-cli-oled.flash.bin
  oledFramebuffer: true
  elided has ssd1306-panel: false    (glass still elided, as it must be)
  origin.board: distro-v1-esp32 | kind: emulator
  identical to QEMU_CAPABILITIES_FULL: true    <- same frozen object
```

It survives because the bundle target keeps the source file name **exactly**,
and because the test is a substring rather than a directory comparison — it even
survives a browser bundler's POSIX `path.basename` shim being handed a Windows
path, which returns the whole string and still contains `cli-oled`.

It is one edit away from breaking, silently, in the safe-looking direction. So:
`src-tauri/src/lib.rs` has a unit test asserting the bundled name contains
`cli-oled`, with the reason in the failure message, and `resources.rs`'s module
docs say it. A rename in `tauri.conf.json` now fails `cargo test` instead of
downgrading a correctness surface four workstreams later.

## 6. For T3 and T4 — three things found here that are theirs

1. **`packages/sesame-qemu` cannot be imported into the webview.**
   `config.ts` imports `node:path` and `node:url` at module scope and the
   package has one export (`.`). So `capabilitiesForImage`, `originForImage`
   and `elidedForImage` are not reachable from `apps/web` as it stands. T4's
   `TauriSesameRobot` needs the capability record on the frontend, and the plan
   (§4) is explicit that the origin claim must come **from the backend rather
   than the app asserting it** — which points at Rust stamping it, not at the
   webview recomputing it. Either way this is a decision, not an oversight to
   discover mid-implementation.
2. **Resolve, do not default.** `resolveQemuOptions()` fills `qemuPath` and
   `imagePath` from `DEFAULT_QEMU_PATH` / `DEFAULT_IMAGE_PATH`, both derived
   from `import.meta.url`. Inside the packaged app those point at a checkout
   that does not exist. Pass `resources::resolve(app, QEMU_EXE)` and
   `resources::resolve(app, FLASH_IMAGE)` explicitly.
3. **`snapshot=on` is not optional here.** `emulator/qemu/run-bridge-demo.mjs`
   uses `-drive file=<image>,if=mtd,format=raw`, which is read-write: the
   guest's NVS and core-dump writes land in the image file. In an installed app
   that file may sit under `C:\Program Files\`, where the write fails, or under
   `%LOCALAPPDATA%`, where it succeeds and quietly mutates the shipped artefact
   so that every subsequent boot differs from the first. `QemuRobotOptions`
   already defaults `snapshot: true`; T3 must not lose it.

## 7. What did not change

- `just dev`, `just dev-sim`, `just run`, `scripts/dev-lab.mjs`,
  `apps/web/server/lab-host.mjs`, `vite.config.ts`: untouched.
- `hardware/`, `packages/`, `emulator/`, `firmware/`, `reference/`: read only.
- T1's seam (`TAURI_EMULATOR_BACKEND`, `detectDesktopShell`,
  `desktopSimulatorProbe`) and the fifth `labHost: 'desktop'` state: untouched.
  `desktop-simulator.test.ts` passes unmodified.
- Tests: **1,058 passing + 1 skipped**, up from 1,045 + 1. The 13 new ones are
  `apps/web/src/__tests__/desktop-resources.test.ts`; nothing existing moved.
  4 Rust unit tests as well (`cargo test`), which did not exist before.
- 11 validators green. `cargo clippy --all-targets` and `cargo fmt --check`
  clean.
- Frontend dependencies: **none added**. `withGlobalTauri` is still `true`, so
  `window.__TAURI__.core.invoke` is what `resource-report.ts` calls;
  `@tauri-apps/api` remains deliberately absent until T4 needs it properly.
  Rust gained `dunce` (already in the lock) and `serde_json` as a
  build-dependency.
- `.gitignore`: **no change needed, verified rather than assumed.** Nothing is
  copied into the repository — `bundle.resources` references `tools/`,
  `emulator/qemu/images/` and `hardware/` **in place**, and everything the build
  produces lands in `src-tauri/target/`, which is already ignored (as is
  `tools/` and `*.bin`). `git status` after a full `tauri build` shows only
  source files.

## 8. Awkward things, named

- **The first `cargo build` after this copies 79 MB** into `target/<profile>/`,
  and `tauri-build` emits `cargo:rerun-if-changed` for each source, so it
  re-checks them on every build. It is not slow in practice (a warm build is
  ~6 s) but the first one after a `cargo clean` is not a hang.
- **A clean clone cannot `tauri build`.** `tools/` and
  `emulator/qemu/images/` are gitignored, so a fresh checkout has neither the
  QEMU binary nor the flash image and the bundler refuses with
  `ResourcePathNotFound`. `build.rs` degrades to a `cargo:warning` and a `None`
  expected size rather than failing, so `cargo check` and `cargo test` still
  work — but T6 should say `node emulator/qemu/fetch-qemu.mjs` and
  `just qemu-image` out loud in whatever it writes about producing an installer.
- **Two ROMs ship that this app will never load.** §1. Deliberate, small,
  stated here so it is not rediscovered as an oversight.
- **The unsigned `qemu-system-xtensa.exe` is now inside an unsigned installer.**
  The plan's §7 already expects SmartScreen on the app; an unsigned 71 MB
  emulator binary landing in `%LOCALAPPDATA%` is a second, independent thing
  Defender may take an interest in. Worth trying on a machine that has never
  seen this project before T6 declares the installer done — not on the nephew's.
- **QEMU has not been run from the installed layout.** T2's remit stops at
  "the files are there and locatable"; §3 argues from QEMU's `os_find_datadir()`
  that `bin/` + `../share/qemu` is the layout it wants, but nothing here has
  actually booted it. That is T3's first five minutes, and if it is wrong the
  fix is a `-L <resource>/qemu/share/qemu` argument, not a re-bundle.
- **`csp: null` is still `csp: null`.** T1 deferred it and T2 did not touch it.
  It is still the loosest setting in the config and T6 should not inherit it
  silently.
