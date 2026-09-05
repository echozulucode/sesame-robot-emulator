# Sesame Lab — task runner
#
# On Windows `just` defaults to `sh`, which is only on PATH inside Git Bash —
# from a PowerShell prompt every recipe failed with "could not find the shell
# `sh`". Pin the shell explicitly instead of depending on how the terminal was
# opened. `powershell.exe` (5.1) ships with Windows and is always present;
# recipes are single commands, so nothing here needs PowerShell 7.
#
# Every recipe is one command, so no shell-specific syntax is involved.
#
#   just            show this
#   just setup      take a fresh clone to `just dev`        <- start here
#   just dev        the emulator and the web UI, together
#   just doctor     check that everything this needs exists

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# ─────────────────────────────────────────────────────────────── quick start

# Show the common recipes, then the full list.
default:
    @echo ""
    @echo "  Sesame Lab"
    @echo ""
    @echo "  just setup      fetch and build everything a fresh clone is missing"
    @echo ""
    @echo "  just dev        real firmware in QEMU + the web UI, hot reload"
    @echo "  just dev-sim    the behavioural simulator + the web UI (boots in ms)"
    @echo "  just run        one origin, no hot reload - closest to production"
    @echo ""
    @echo "  just tauri-dev  the desktop app - real firmware in the bundled QEMU"
    @echo "  just tauri-build   the installer; just tauri-install   check it on a clean install"
    @echo ""
    @echo "  just doctor     check prerequisites"
    @echo "  just check      build + typecheck + 934 tests + 11 validators"
    @echo "  just verify-all the web target AND the packaged target, one verdict"
    @echo ""
    @just --list --unsorted

# Lab host on :8099 + vite in front of it; stops both together. Open the vite URL.
# Real firmware in QEMU + the web UI, together. START HERE.
dev:
    node scripts/dev-lab.mjs

# Same, but backed by the behavioural simulator: no emulator boot, no ~28% panic retry.
dev-sim:
    node scripts/dev-lab.mjs --backend sim

# Move the lab host off :8099 (also set SESAME_LAB_HOST so vite's proxy follows).
dev-port port:
    node scripts/dev-lab.mjs --host-port {{port}}

# Needs apps/web/dist — run `just build-web` first if it is stale.
# One origin, no hot reload: the lab host serves the built app itself.
run:
    node apps/web/server/lab-host.mjs

# Single origin against the simulator.
run-sim:
    node apps/web/server/lab-host.mjs --backend sim

# ────────────────────────────────────────────────────────────────── emulator

# One-shot: boot real firmware, send `wave`, print the servo events it answers with.
qemu:
    node packages/sesame-qemu/dist/cli.js --command wave

# Walk hardware-map.json's 20-step bootOrder under QEMU with per-step breakpoints.
qemu-boot:
    node emulator/qemu/run-boot-ladder.mjs

# QEMU -> the unmodified Phase-0 bridge -> WebSocket. Prints the envelopes.
qemu-bridge:
    node emulator/qemu/run-bridge-demo.mjs

# Measure the ISSUE-022 boot-panic rate (~28%, mitigated by connect() retrying).
qemu-flake runs='20':
    node emulator/qemu/run-flake-trial.mjs --runs {{runs}} --tag baseline

# Rebuild the QEMU-bootable flash image from the pinned firmware build.
qemu-image:
    node emulator/qemu/build-qemu-images.mjs cli

# Read the LEDC registers out of the live peripheral (Q3: correct duty, no waveform).
qemu-ledc:
    node emulator/qemu/probe-ledc.mjs --tag ledc

# ─────────────────────────────────────────────────────────────────── the API

# Sesame-compatible HTTP API on 127.0.0.1:8080, fronting the simulator.
api:
    node packages/sesame-api/dist/cli.js

# Same, fronting real firmware under QEMU.
api-qemu:
    node packages/sesame-api/dist/cli.js --backend qemu

# Replay real runWavePose choreography through the bridge into the debug viewer.
demo:
    pnpm demo:web

# ────────────────────────────────────────────────────────────────────── check

# Everything: build, typecheck, tests, validators.
check: build typecheck test validate

build:
    pnpm -r build

build-web:
    pnpm --filter @sesame-lab/web build

typecheck:
    pnpm -r typecheck

test:
    pnpm -r test

# All 11 data validators. Any failure stops the run.
validate:
    pnpm -s validate:reproducibility
    pnpm -s validate:hardware-map
    pnpm -s validate:joint-map
    pnpm -s validate:assets-inventory
    pnpm -s validate:assembly-map
    pnpm -s validate:gltf
    pnpm -s validate:calibration
    pnpm -s validate:replay-fixture
    pnpm -s validate:telemetry-literals
    pnpm -s validate:source-annotations
    pnpm -s validate:lessons

# Drive a real headless browser: 32 captures with assertions. Slow (minutes), boots QEMU.
capture:
    pnpm capture:web

# T7. The web build and the packaged build are two targets, and two targets that
# are never verified together drift. This runs both, sequentially — the harness
# with `--skip-packaged` so T5's phase 14 runs exactly once, in the packaged
# target, because two WebView2 windows cannot be driven at the same time — and
# prints one verdict naming which targets actually ran.
#
#   just verify-all                            all three targets, ~13 min
#   just verify-all --only packaged,installer  the desktop half, ~37 s
#   just verify-all --list                     the plan and what it costs
#
# Measured on this machine: web 733 s, packaged 29 s, installer 8 s. There is
# no `--fast`: one was written and measured at 12m 13s against the full run's
# 12m 50s — a 5% saving — and deleted, because a flag that saves thirty-seven
# seconds gets used in place of the real thing for no benefit. The subset worth
# having is `--only`, which always exits 3.
#
# Exit 0 only when every requested target RAN AND PASSED. 1 when one failed.
# 2 when nothing ran at all. **3 when what ran passed and something did not
# run** — the usual outcome on a tree with no `just tauri-build` artefact, and
# non-zero on purpose: a green web harness beside an unverified package is not
# a verified tree.
#
# It never writes into docs/findings/assets: `just capture` owns the committed
# 44-capture evidence, and this writes its 41-capture run to gitignored scratch.
#
# Verify the web target and the packaged target together, and say which ran.
verify-all *args:
    node scripts/verify-all.mjs {{args}}

# ──────────────────────────────────────────────────────────── desktop app
#
# Phase 5. The desktop shell is `src-tauri/` at the repo root; `just dev` and
# everything above it are unchanged and remain the development path.
#
# T1 shipped the window with nothing behind it and said so on the panel. T3 gave
# it a supervisor and T4 gave it a `SesameRobot`, so the window now opens on the
# BUNDLED QEMU running real firmware, with no lab host and no HTTP anywhere in
# the path. `just dev` is unchanged and remains the development path.

# Vite + the Tauri window, driving real firmware in the bundled QEMU.
tauri-dev:
    pnpm exec tauri dev

# T6 narrowed `bundle.targets` to NSIS alone, so this produces exactly one
# artefact: `src-tauri/target/release/bundle/nsis/Sesame Lab_0.1.0_x64-setup.exe`,
# ~21 MiB, which installs PER-USER into %LOCALAPPDATA% and needs no administrator.
# An MSI is still one flag away — `pnpm exec tauri build --bundles msi` — and is
# the thing to reach for if this is ever deployed by a school's IT rather than
# double-clicked by the person using it.
#
# A clean clone cannot run this: `tools/` and `emulator/qemu/images/` are
# gitignored, so fetch them first —
#     just setup --all-images
#
# T7 corrected what used to be written here. It said `just qemu-image`, which
# builds `distro-v1-esp32-cli` — the image `just dev` boots. `tauri.conf.json`
# bundles `distro-v1-esp32-cli-oled`, a different file, and a clone that
# followed the old two lines got a `tauri build` that failed on a missing
# resource with nothing anywhere saying why. `--all-images` builds both, plus
# the `nowifi` image `just capture` phase 5 needs.
#
# Build apps/web/dist, then the per-user Windows installer (NSIS, ~21 MiB).
tauri-build:
    pnpm exec tauri build

# T6's acceptance test: install the NSIS installer into a directory that did not
# exist, with the REPOSITORY STRIPPED FROM PATH and the working directory set to
# a fresh empty one, then ask the installed copy where its 22 bundled resources
# are, boot the bundled QEMU out of it, check every licence text a recipient is
# owed, and uninstall it again — asserting nothing is left behind and no HKCU
# uninstall key survives.
#
# It also prints the placeholders in the GPL source offer that only the person
# distributing this can fill in. They are deliberate; see licenses/.
#
#   just tauri-install                  install, check, uninstall
#   just tauri-install --keep           leave it installed (for `just tauri-honesty`)
#   just tauri-install --no-emulator    skip the QEMU boot, ~20 s instead of ~40
#
# Exit 0 clean, 1 with problems, 2 when there was no installer to check.
#
# Install the built installer somewhere fresh, check it, and uninstall it again.
tauri-install *args:
    node scripts/verify-install.mjs {{args}}

# Ask the BUILT exe where its bundled resources are; fail if any is missing or
# the wrong size. This is T2's acceptance test in the form you can re-run:
# `app.path()` resolves against the directory the executable is IN, so pointing
# it at an installed copy checks the installed copy. The exe is a GUI-subsystem
# binary with no stdout, so the report is a file and this prints it.
#   just tauri-resources                     # src-tauri/target/release
#   just tauri-resources debug               # after a plain `cargo build`
tauri-resources profile='release':
    & {$o="src-tauri/target/{{profile}}/resource-report.json"; & "src-tauri/target/{{profile}}/sesame-lab-desktop.exe" --resource-report $o; $rc=$LASTEXITCODE; Get-Content $o; exit $rc}

# T3's acceptance test, in the form you can re-run. Boots the BUNDLED QEMU from
# the built exe with no window, streams UART0, stops, and then asks `tasklist` —
# not its own bookkeeping — whether anything survived. Exits non-zero if a boot
# failed, if the byte stream is missing the banner or the telemetry that
# precedes it, or if a single qemu-system-xtensa.exe is left behind.
#
# Each cycle is a fresh process, so `--cycles 10` is the repeated start/stop
# case. Expect ~2 s per boot plus ~2 s per ISSUE-20260823-022 retry (~28% of
# boots); the raw stream of each cycle is written beside the report as
# `.cycleN.uart.bin`, unaltered, so the summary can be checked rather than
# believed.
#   just tauri-emulator                # release, 1 cycle
#   just tauri-emulator debug 10       # after a plain `cargo build`, 10 cycles
tauri-emulator profile='release' cycles='1':
    & {$o="src-tauri/target/{{profile}}/emulator-selftest.json"; & "src-tauri/target/{{profile}}/sesame-lab-desktop.exe" --emulator-selftest $o --cycles {{cycles}}; $rc=$LASTEXITCODE; Get-Content $o; exit $rc}

# T4's acceptance test: describeRobotContract's fifteen cases against
# TauriSesameRobot, with the SHIPPED Rust supervisor on the other end. Each case
# boots the bundled QEMU through `sesame-lab-desktop.exe --supervisor-stdio`, so
# a `cargo build` has to have happened first - the suite skips itself, loudly,
# when neither target profile exists. ~70 s.
tauri-contract:
    pnpm --filter @sesame-lab/web exec vitest run src/__tests__/tauri-contract.test.ts

# T5's acceptance test: every honesty surface, asserted against the PACKAGED
# window rather than against `tauri dev` or Vite. Launches the built exe with
# WebView2 remote debugging, checks the CDP target really says tauri.localhost
# (a plain `cargo build --release` serves devUrl and would have this grading a
# dev server), drives a real wave through the bundled QEMU, and breaks seven
# things in the window first to prove each check can fail. ~90 s.
#
# This is the last phase of `just capture`; the recipe exists because it is the
# only one that needs a build artefact instead of a browser, and because during
# desktop work it is the one you re-run.
#
#   just tauri-honesty                                   # target/release
#   just tauri-honesty "C:/Program Files/Sesame Lab/Sesame Lab.exe"   # installed
#
# Exit 0 clean, 1 with problems, 2 when there was no artefact to check — three
# codes, because "nothing was verified" must not read as "everything passed".
tauri-honesty exe='':
    & {if ('{{exe}}' -eq '') { node scripts/verify-packaged-honesty.mjs } else { node scripts/verify-packaged-honesty.mjs --packaged-exe '{{exe}}' }}

# ────────────────────────────────────────────────────── firmware and assets

# The source explorer refuses to render without it.
# Clone the pinned upstream Sesame tree into firmware/upstream (gitignored).
[windows]
upstream:
    pwsh -NoProfile -File scripts/fetch-upstream.ps1

[unix]
upstream:
    bash scripts/fetch-upstream.sh

# Build a firmware profile: s2mini | distro-v3-s3 | distro-v1-esp32 | s2mini-instrumented | s2mini-oled
firmware profile='s2mini':
    pwsh -NoProfile -File scripts/build-firmware.ps1 {{profile}}

# Needs the python env: run scripts/setup-asset-env.ps1 (or .sh) first.
# Regenerate the articulated GLB from the STLs and the CAD assembly map.
assets:
    python scripts/build-gltf.py

# Regenerate every derived data artifact, then validate them all.
regen: && validate
    pnpm build:joint-map
    pnpm build:calibration
    pnpm build:replay-fixture
    pnpm build:source-annotations
    pnpm build:lessons

# ───────────────────────────────────────────────────────────────── prereqs

# T7. Everything a clone needs that git does not carry — dependencies, the
# workspace build, Espressif's QEMU, the pinned upstream tree, the Arduino
# toolchain and the flash image `just dev` boots. Four of those were README
# prose and a fifth was named nowhere; this is the command.
#
# Idempotent: each step is detected before it runs and detected AGAIN
# afterwards, so a fetcher that exits 0 without producing anything is reported
# as a failure rather than as a step that ran. Re-running it on a warm clone
# takes a couple of seconds and says "already present" for every row.
#
#   just setup                 the `just dev` path — measured at ~37 min and
#                              ~15 GB on a real cold clone, of which the
#                              Arduino/ESP32 toolchain is 31 min and 14 GB
#   just setup --sim           the `just dev-sim` path — ~2 min, no QEMU and no
#                              14 GB toolchain
#   just setup --all-images    also the two flash images the VERIFICATION
#                              targets need: distro-v1-esp32-nowifi for
#                              `just capture` phase 5, distro-v1-esp32-cli-oled
#                              for `just tauri-build`
#   just setup --dry-run       the plan and what it costs, changes nothing
#
# Take a fresh clone to `just dev`. Safe to re-run; skips what is already there.
setup *args:
    node scripts/setup.mjs {{args}}

# Reads the same list `just setup` acts on (scripts/lib/prereqs.mjs), so the
# two cannot disagree about what a clone is missing, and it closes by naming
# which of its failing rows `just setup` would have handled.
#
# Check that everything the recipes need is actually present.
doctor:
    node scripts/doctor.mjs

# Remove build output. Leaves tools/, firmware/upstream/ and node_modules alone.
clean:
    pnpm -r --if-present run clean
