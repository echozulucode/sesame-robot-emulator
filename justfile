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
#   just dev        the emulator and the web UI, together   <- start here
#   just doctor     check that everything this needs exists

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# ─────────────────────────────────────────────────────────────── quick start

# Show the common recipes, then the full list.
default:
    @echo ""
    @echo "  Sesame Lab"
    @echo ""
    @echo "  just dev        real firmware in QEMU + the web UI, hot reload"
    @echo "  just dev-sim    the behavioural simulator + the web UI (boots in ms)"
    @echo "  just run        one origin, no hot reload - closest to production"
    @echo ""
    @echo "  just tauri-dev  the desktop app (simulator only until Phase 5 T4)"
    @echo ""
    @echo "  just doctor     check prerequisites"
    @echo "  just check      build + typecheck + 934 tests + 11 validators"
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

# ──────────────────────────────────────────────────────────── desktop app
#
# Phase 5. The desktop shell is `src-tauri/` at the repo root; `just dev` and
# everything above it are unchanged and remain the development path.
#
# T1 ships the window and nothing behind it: there is no lab host inside the
# app, so it opens on the BEHAVIOURAL SIMULATOR and says so on the panel. Real
# firmware under QEMU is `just dev`, and stays `just dev` until T3/T4 land.

# Vite + the Tauri window. Simulator only until T4 - no QEMU, no lab host.
tauri-dev:
    pnpm exec tauri dev

# Build apps/web/dist, then the Windows installer. Slow on a cold cargo cache.
tauri-build:
    pnpm exec tauri build

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

# Check that everything the recipes need is actually present.
doctor:
    node scripts/doctor.mjs

# Remove build output. Leaves tools/, firmware/upstream/ and node_modules alone.
clean:
    pnpm -r --if-present run clean
