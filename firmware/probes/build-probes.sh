#!/usr/bin/env bash
# Build the R2/R3 freestanding Xtensa probe ELFs with the REAL ESP32-S2
# toolchain that F3 installed portably under tools/.
#
#   bash firmware/probes/build-probes.sh
#
# Outputs (gitignored - *.elf/*.map are in .gitignore):
#   firmware/probes/build/<name>.elf   loaded by the .resc scripts
#   firmware/probes/build/<name>.dis   disassembly, used as evidence in R2
#   firmware/probes/build/<name>.map   link map
#   firmware/probes/build/manifest.txt sha256 + size of every ELF
#
# Everything is invoked through the PER-TARGET driver name
# (xtensa-esp32s2-elf-gcc), never the unified xtensa-esp-elf-gcc: F3 section 1
# records that all four drivers report -dumpmachine = xtensa-esp-elf and only
# the per-target shim supplies the right core configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TC="$ROOT/tools/arduino-data/data/packages/esp32/tools/esp-x32/2601/bin"
GCC="$TC/xtensa-esp32s2-elf-gcc.exe"
OBJDUMP="$TC/xtensa-esp32s2-elf-objdump.exe"
SIZE="$TC/xtensa-esp32s2-elf-size.exe"
OBJCOPY="$TC/xtensa-esp32s2-elf-objcopy.exe"
SRC="$ROOT/firmware/probes"
OUT="$SRC/build"

[ -x "$GCC" ] || { echo "missing toolchain: $GCC" >&2; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/*.elf "$OUT"/*.dis "$OUT"/*.map "$OUT/manifest.txt"

# Flags chosen to match the real esp32s2-libs 3.3.11 c_flags where it matters
# for code generation (-mlongcalls, -fstrict-volatile-bitfields, -fno-jump-tables,
# -fno-tree-switch-conversion, -std=gnu17) while staying freestanding.
COMMON=(
  -Os -g -std=gnu17
  -mlongcalls -mtext-section-literals
  -ffunction-sections -fdata-sections
  -fstrict-volatile-bitfields -fno-jump-tables -fno-tree-switch-conversion
  -fno-builtin -ffreestanding -nostdlib -nostartfiles
  -Wall -Wextra -Wno-multichar -Wno-unused-parameter
  -I "$SRC/r2"
)

build() {   # build <name> <dir> <abi-extra...> -- <sources...>
  local name="$1"; shift
  local dir="$1"; shift
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  echo "[build] $name"
  "$GCC" "${COMMON[@]}" "${extra[@]}" \
      -T "$SRC/r2/probe.ld" \
      -Wl,-Map="$OUT/$name.map" -Wl,--no-warn-rwx-segments \
      -o "$OUT/$name.elf" "$@"
  "$OBJDUMP" -d -S "$OUT/$name.elf" > "$OUT/$name.dis"
  "$SIZE" "$OUT/$name.elf" | tail -1
}

cd "$SRC"

# --- R2 ladder ------------------------------------------------------------
# rung 1 is the ONLY one built call0: rung 1 vs rung 2 differ in the ABI and
# nothing else, so any delta between them is attributable to register windows.
build r2-rung1-arith  r2 -mabi=call0 -DPROBE_CALL0 -- r2/start.S r2/rung1_arith.c
build r2-rung2-call   r2 -- r2/start.S r2/vectors.S r2/rung2_call.c
build r2-rung3-window r2 -- r2/start.S r2/vectors.S r2/window_chains.S r2/rung3_window.c
build r2-rung4-sr     r2 -- r2/start.S r2/vectors.S r2/rung4_sr.c
build r2-rung5-mem    r2 -- r2/start.S r2/vectors.S r2/rung5_mem.c
# Same source with the `rer` probe enabled. Renode 1.16.1 hard-aborts on rer,
# so this ELF exists only to reproduce that abort on demand.
build r2-rung5b-rer   r2 -DR5_PROBE_RER -- r2/start.S r2/vectors.S r2/rung5_mem.c

# --- R3 UART probe --------------------------------------------------------
build r3-uart-hello   r3 -- r2/start.S r2/vectors.S r3/uart_hello.c

# Manifest.
#
# DETERMINISM NOTE: the full ELF is NOT bit-reproducible across rebuilds.
# Exactly six bytes differ, inside .strtab: the GCC temporary basename used when
# preprocessing the .S inputs, recorded as an STT_FILE symbol. No loadable byte,
# no instruction and no debug line changes. The image-sha256 column is the hash
# of the same ELF after --strip-all, and that IS bit-identical across rebuilds -
# quote it when you need to say exactly which binary was run.
{
  echo "# built $(date -u +%Y-%m-%dT%H:%M:%SZ) by firmware/probes/build-probes.sh"
  "$GCC" --version | head -1
  echo "# elf-sha256 | bytes | image-sha256 (--strip-all, reproducible) | name"
  for f in "$OUT"/*.elf; do
    "$OBJCOPY" --strip-all "$f" "$OUT/stripped.tmp"
    printf '%s %7d %s %s\n' \
        "$(sha256sum "$f" | cut -d' ' -f1)" \
        "$(stat -c %s "$f")" \
        "$(sha256sum "$OUT/stripped.tmp" | cut -d' ' -f1)" \
        "$(basename "$f")"
  done
  rm -f "$OUT/stripped.tmp"
} > "$OUT/manifest.txt"

cat "$OUT/manifest.txt"
