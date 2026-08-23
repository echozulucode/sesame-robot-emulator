#!/usr/bin/env bash
# F3 - install the portable, repo-local Arduino firmware toolchain (POSIX shell
# / Git Bash equivalent of setup-firmware-toolchain.ps1).
#
# Nothing is installed machine-wide. Everything lands under tools/.
# Every arduino-cli invocation passes --config-file: without it arduino-cli
# falls back to %LOCALAPPDATA%\Arduino15 and writes an inventory.yaml there.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

ARDUINO_CLI_VERSION=1.5.1
ARDUINO_CLI_SHA256=fabe42e0eb04d00e776a66178299ff95a46c623dbc260f997e58fd514853dd40
ESP32_CORE_VERSION=3.3.11
# ESP32Servo pinned to 3.0.9 by upstream (firmware/README.md:42,47,175):
# newer releases can leak a write on one servo across channels, ESP32Servo#103.
LIBRARIES=(
  "ESP32Servo@3.0.9"
  "Adafruit SSD1306@2.5.17"
  "Adafruit GFX Library@1.12.6"
  "Adafruit BusIO@1.17.4"
)

cli_dir="$repo/tools/arduino-cli"
data_root="$repo/tools/arduino-data"
cli="$cli_dir/arduino-cli.exe"
cfg="$cli_dir/arduino-cli.yaml"

mkdir -p "$cli_dir" "$data_root/data" "$data_root/downloads" "$data_root/user"

if [ ! -f "$cli" ]; then
  zip="arduino-cli_${ARDUINO_CLI_VERSION}_Windows_64bit.zip"
  echo "[cli]   downloading $zip"
  curl -sSL -o "$cli_dir/$zip" "https://downloads.arduino.cc/arduino-cli/$zip"
  actual="$(sha256sum "$cli_dir/$zip" | cut -d' ' -f1)"
  if [ "$actual" != "$ARDUINO_CLI_SHA256" ]; then
    echo "arduino-cli archive SHA-256 mismatch: expected $ARDUINO_CLI_SHA256 got $actual" >&2
    exit 1
  fi
  unzip -o -q "$cli_dir/$zip" -d "$cli_dir"
  echo "[cli]   verified + extracted"
fi
[ -f "$cfg" ] || { echo "Missing $cfg - it is checked in and must not be deleted." >&2; exit 1; }

export ARDUINO_DIRECTORIES_DATA="$(cygpath -w "$data_root/data" 2>/dev/null || echo "$data_root/data")"
export ARDUINO_DIRECTORIES_DOWNLOADS="$(cygpath -w "$data_root/downloads" 2>/dev/null || echo "$data_root/downloads")"
export ARDUINO_DIRECTORIES_USER="$(cygpath -w "$data_root/user" 2>/dev/null || echo "$data_root/user")"

acli() { "$cli" --config-file "$cfg" "$@"; }

echo '[index] updating board manager index'
acli core update-index

echo "[core]  installing esp32:esp32@$ESP32_CORE_VERSION (multi-GB, slow first time)"
acli core install "esp32:esp32@$ESP32_CORE_VERSION"

for spec in "${LIBRARIES[@]}"; do
  echo "[lib]   $spec"
  acli lib install "$spec"
done

global15="$HOME/AppData/Local/Arduino15"
if [ -e "$global15" ]; then
  echo "ERROR: $global15 exists - something invoked arduino-cli without --config-file." >&2
  find "$global15" >&2
  exit 1
fi
echo "[check] $global15 absent - no machine-wide state. OK"

acli core list
acli lib list
