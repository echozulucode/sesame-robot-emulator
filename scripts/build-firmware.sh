#!/usr/bin/env bash
# F3 - build a Sesame firmware profile reproducibly.
#
# Thin wrapper around scripts/build-firmware.mjs, which holds the real logic
# (scratch copy -> patch -> verify against hardware-map.json -> arduino-cli
# compile -> artifacts + build-manifest.json). Keeping the logic in Node stops
# the PowerShell and POSIX entry points from drifting apart.
#
# Usage: scripts/build-firmware.sh <s2mini|s2mini-instrumented|distro-v3-s3|distro-v1-esp32> [--clean]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required on PATH (the build driver is scripts/build-firmware.mjs)." >&2
  exit 1
fi
if [ ! -f "$repo/tools/arduino-cli/arduino-cli.exe" ]; then
  echo "Portable arduino-cli not found. Run scripts/setup-firmware-toolchain.sh first." >&2
  exit 1
fi

exec node "$here/build-firmware.mjs" "$@"
