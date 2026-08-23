# F3 — Reproducible firmware build baseline (Experiment 1)

**Task:** F3 · **Date:** 2026-08-23 · **Agent:** `firmware-build`
**Gate:** the research report places this before all emulator work — *"no emulator work before pass."*

**Result: PASS.** All three profiles build clean, and all three are **bit-for-bit
reproducible** across a full clean rebuild. Nothing was installed machine-wide.

---

## 1. What R2 needs (read this first)

R2 is blocked on the Xtensa toolchain. It is installed and working.

### Compilers

Canonical location (version-named, stable across rebuilds):

```
C:\Projects\sesame-robot-emulator\tools\arduino-data\data\packages\esp32\tools\esp-x32\2601\bin\
```

| Binary | Target | Version |
|---|---|---|
| `xtensa-esp32-elf-gcc.exe` | ESP32 (LX6) | 14.2.0 |
| `xtensa-esp32s2-elf-gcc.exe` | ESP32-S2 (LX7) | 14.2.0 |
| `xtensa-esp32s3-elf-gcc.exe` | ESP32-S3 (LX7) | 14.2.0 |
| `xtensa-esp-elf-gcc.exe` | unified driver | 14.2.0 |

Full version string, identical for all four:
`xtensa-esp-elf-gcc.exe (crosstool-NG esp-14.2.0_20260121) 14.2.0`

**Trap worth knowing:** this is a *unified* toolchain. The three per-target names
are ~906 KB shims around the single 2.3 MB `xtensa-esp-elf-gcc`, and all four
answer `-dumpmachine` with `xtensa-esp-elf`. Do not infer the target from the
binary name or from `-dumpmachine`; the shim supplies the core configuration.
Invoke the per-target name and let it do that, rather than calling the unified
driver and hoping the default is right. The matching `as`, `ld`, `objdump`,
`nm`, `readelf`, `objcopy`, `size`, `strip` and `addr2line` exist under all four
prefixes in the same directory.

A second, byte-identical copy of the toolchain lives at
`tools\arduino-data\data\internal\esp32_esp-x32_2601_7eec6aba10bf540e\bin\` —
that is the copy `arduino-cli compile --profile` actually invokes, because
profile builds resolve tools into a content-addressed `internal/` tree. The
suffix is a content hash and will change if the pin changes, so **prefer the
`packages/...` path** for anything scripted.

### Debugger

```
tools\arduino-data\data\packages\esp32\tools\xtensa-esp-elf-gdb\17.1_20260402\bin\
```
GDB 17.1 (`_20260402`), one binary per host Python ABI
(`xtensa-esp-elf-gdb-3.8.exe` … `-3.14.exe`) plus `xtensa-esp-elf-gdb-no-python.exe`.
For Renode's GDB stub the no-python build is the one with no host dependencies.

### Linker scripts and startup objects

Per target, under `tools\arduino-data\data\packages\esp32\tools\<target>-libs\3.3.11\`
(`esp32-libs`, `esp32s2-libs`, `esp32s3-libs`):

- `ld/` — the linker scripts. For S2: `memory.ld`, `sections.ld`,
  `esp32s2.peripherals.ld`, and the ROM-symbol scripts `esp32s2.rom.ld`,
  `.rom.api.ld`, `.rom.libgcc.ld`, `.rom.libc-funcs.ld`,
  `.rom.newlib-{reent-funcs,data,time,nano}.ld`, `.rom.spiflash_legacy.ld`.
- `flags/ld_scripts` — the exact `-T` ordering the real build uses:
  `-T esp32s2.peripherals.ld -T esp32s2.rom.ld -T esp32s2.rom.api.ld -T esp32s2.rom.libgcc.ld -T esp32s2.rom.libc-funcs.ld -T esp32s2.rom.newlib-reent-funcs.ld -T esp32s2.rom.newlib-data.ld -T esp32s2.rom.spiflash_legacy.ld -T memory.ld -T sections.ld`
- `flags/ld_flags`, `flags/c_flags`, `flags/cpp_flags` — the response files.
- `lib/` — the prebuilt ESP-IDF static libraries.
- `sdkconfig`, `versions.txt` — the IDF configuration these were built with.

There are **no crt objects**: `ld_flags` contains `-nostartfiles`. The entry
point comes from `ENTRY(call_start_cpu0)` in `sections.ld`, and
`call_start_cpu0` is defined in `lib/libesp_system.a(cpu_start.c.obj)`. The
linked S2 ELF's entry point is **`0x40025738`**, machine `Tensilica Xtensa
Processor`, flags `0x300`.

The ROM `.ld` files are pure symbol-address maps for the on-chip ROM. If Renode
has no ROM image, every one of those addresses is an unbacked read — likely the
first thing R2/R4 trips over, and worth checking before writing any peripheral
model. The IDF version behind these libs is **v5.5.5**.

---

## 2. What was pinned, and why

| Component | Version | Why this one |
|---|---|---|
| `arduino-cli` | **1.5.1** | Newest release at the time (2026-06-05). Supports declarative `sketch.yaml` profiles, which is what makes the pinning checked-in rather than tribal. |
| `esp32:esp32` core | **3.3.11** | Newest 3.x. Upstream (`firmware/README.md:39`) only requires "v2.0.0 or higher", so nothing constrains us downward; picking the newest concrete release maximises the life of the pin. Recorded as an exact version — never `latest`. |
| `ESP32Servo` | **3.0.9** | Mandated by upstream. See §2.1. |
| `Adafruit SSD1306` | **2.5.17** | Newest; upstream gives no version constraint. |
| `Adafruit GFX Library` | **1.12.6** | Newest; upstream gives no version constraint. |
| `Adafruit BusIO` | **1.17.4** | Not named by upstream, but a hard dependency of SSD1306. Pinned so it cannot float. |

`arduino-cli` archive: `arduino-cli_1.5.1_Windows_64bit.zip`,
SHA-256 `fabe42e0eb04d00e776a66178299ff95a46c623dbc260f997e58fd514853dd40`,
verified against `1.5.1-checksums.txt` from the GitHub release before extraction.

The build also pulls in the core's bundled libraries, whose versions track the
core: `WiFi`, `WebServer`, `DNSServer`, `ESPmDNS`, `Wire`, `SPI`, `FS`, `Hash`,
`Networking`, `ESP32 Async UDP` — all `3.3.11`.

### 2.1 The ESP32Servo 3.0.9 claim — verified

The task asked whether upstream's warning is real. It is, and here is the exact
text.

`firmware/README.md:47`:

> Use **ESP32Servo v3.0.9** for this project. Newer releases currently have a
> known issue where writing to one servo can affect multiple channels
> ([madhephaestus/ESP32Servo#103](https://github.com/madhephaestus/ESP32Servo/issues/103)).

`firmware/README.md:175` repeats it:

> `ESP32Servo` **v3.0.9**: Low-level PWM timer management. (Pinned due to known
> multi-servo command leak in newer versions: madhephaestus/ESP32Servo#103)

So the README says "writing one servo can affect multiple channels", cites an
upstream issue number, and states it twice. It does **not** say the newer
versions fail to build, and it does not say which versions are affected beyond
"newer". The library index confirms 3.1.1, 3.1.2, 3.1.3, 3.2.0 and 3.2.1 exist;
we deliberately use none of them.

This matters beyond flashing a real robot: a cross-channel write leak would
corrupt exactly the servo-target signal that Gate B is trying to extract, so the
pin is load-bearing for the emulator, not just for hardware.

**Not verified by us:** we have not reproduced the bug or read issue #103. The
claim is recorded as upstream's, with its provenance, and the pin is honoured.

---

## 3. Isolation — and two leaks that had to be closed

**Requirement:** nothing machine-wide. Everything under `tools/` (gitignored).

Baseline before starting: `%LOCALAPPDATA%\Arduino15` **did not exist at all** —
the cleanest possible control, since any appearance is unambiguous evidence of a
leak rather than a pre-existing directory being touched.

**Final state: both `%LOCALAPPDATA%\Arduino15` and `%LOCALAPPDATA%\arduino` are
absent.** Verified after the final clean build of all three profiles.

Getting there required closing two separate leaks, both worth recording because
neither is obvious and both were found by observation rather than by reading
docs.

### Leak 1 — `%LOCALAPPDATA%\Arduino15\inventory.yaml`

Setting `directories.data/downloads/user` is not sufficient. **Any `arduino-cli`
invocation that omits `--config-file` falls back to the default data directory** —
including something as innocuous as `arduino-cli version`, which writes an
installation-identity `inventory.yaml` (a UUID `id` and `secret`) there.

That is exactly how it happened here: a bare `arduino-cli.exe version` run
immediately after extraction, to confirm the binary worked, created the
directory before any config file existed. Cause confirmed by deleting the
directory and re-running the same command with and without `--config-file`; only
the bare form recreates it.

Mitigations now in place, all three:

1. `tools/arduino-cli/arduino-cli.yaml` sets all directories explicitly.
2. `ARDUINO_DIRECTORIES_{DATA,DOWNLOADS,USER}` are exported by both the setup
   script and the build driver, as a second line of defence for any invocation
   that somehow loses the flag.
3. `scripts/setup-firmware-toolchain.{ps1,sh}` **fails the run** if either
   directory exists at the end, printing its contents. A silent leak is worse
   than a failed setup.

### Leak 2 — `%LOCALAPPDATA%\arduino` (the compilation cache)

A second, independent default. `build_cache.path` defaults to
`C:\Users\<user>\AppData\Local\arduino` and is **not** covered by
`directories.*`. It was observed creating `sketches/<hash>/` directories there
during F3 (three of them) even though the real builds used an explicit
`--build-path`; the culprit was the `--show-properties` calls, which take no
`--build-path`.

Fixed by setting `build_cache.path` into `tools/arduino-data/builds` plus an
`ARDUINO_BUILD_CACHE_PATH` env var, and by extending the setup script's
assertion to cover both directories.

`compilations_before_purge: 0` is also set. The default (10) would let the cache
evict itself mid-experiment, which would silently change what a "clean rebuild"
actually rebuilds — the one variable the determinism check must hold fixed.

### Note on `arduino-cli.yaml`

`tools/` is gitignored, so the config file is **not** under version control. It
is therefore *generated* by `scripts/setup-firmware-toolchain.{ps1,sh}` with
absolute paths derived from the repo root, rather than being a checked-in file
the scripts assume exists. (Absolute paths are unavoidable: arduino-cli resolves
relative directory settings against the process CWD, not against the config
file.)

### Package index URL

Upstream's `firmware/README.md:37` gives
`https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`.
The phase-0 ground truth notes that `raw.githubusercontent.com` has hit TLS
certificate-revocation failures on this host.

We used **`https://espressif.github.io/arduino-esp32/package_esp32_index.json`**,
which worked first time. For the record, both returned HTTP 200 when probed with
`curl` during this run, so the revocation failure is intermittent rather than
permanent — the GitHub Pages origin is used because it is the one we can rely on,
not because the README's URL is wrong.

---

## 4. The three profiles

Declared in `firmware/build/sketch.yaml` as arduino-cli sketch profiles — the
preferred declarative mechanism, supported by CLI 1.5.1. The build driver copies
that file into the scratch sketch directory and runs
`arduino-cli compile --profile <name>`.

All FQBNs and board options were read from the **installed core** with
`arduino-cli board details -b <fqbn>`, not guessed.

| Profile | FQBN |
|---|---|
| `s2mini` | `esp32:esp32:lolin_s2_mini:CDCOnBoot=default,PartitionScheme=default,DebugLevel=none,EraseFlash=none` |
| `distro-v3-s3` | `esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashMode=qio,FlashSize=4M,PartitionScheme=default,UploadSpeed=921600,CPUFreq=240,PSRAM=disabled,DebugLevel=none,LoopCore=1,EventsCore=1,USBMode=hwcdc,EraseFlash=none` |
| `distro-v1-esp32` | `esp32:esp32:esp32:FlashMode=qio,FlashFreq=80,FlashSize=4M,PartitionScheme=default,UploadSpeed=921600,CPUFreq=240,PSRAM=disabled,DebugLevel=none,LoopCore=1,EventsCore=1,EraseFlash=none` |

### Board-option findings

**`CDCOnBoot` is spelled inversely on the two boards.** On `lolin_s2_mini`,
"Enabled" is `CDCOnBoot=default` and "Disabled" is `CDCOnBoot=dis_cdc` — CDC is
on by default. On `esp32s3`, "Enabled" is `CDCOnBoot=cdc` and the board default
is *Disabled*. Copying the option string from one profile to the other silently
inverts the setting, and on the S3 that would break the serial monitor upstream
says is required (`firmware/README.md:70`). Both are written out explicitly for
this reason.

**The S2 Mini has no `UploadSpeed` menu in core 3.3.11.** `firmware/README.md:66`
asks for "Upload Speed: 921600" for the Lolin S2 Mini, but that board exposes no
such option. Nothing to pin. It only affects flashing, never the binary, so it
costs the build nothing — but it is a small doc-vs-core drift.

**Partition scheme.** Upstream asks for "Default 4MB with spiffs" on both S2 Mini
and S3 (`README.md:68`, `:72`); that is `PartitionScheme=default`
(1.2 MB APP / 1.5 MB SPIFFS), confirmed present on all three boards. Flash mode
"QIO 80MHz" for the S3 is `FlashMode=qio`.

One consequence worth flagging: the requested partition scheme gives a **1.2 MB
app slot**, and the firmware is using 85–87 % of it (§6). Upstream's own
recommended settings leave roughly 170–190 KB of headroom.

### Patches

The S3 and V1 configurations need upstream's alternate pin/I²C blocks
un-commented. `firmware/upstream/` was never touched. Two patches live in
`firmware/patches/` and are applied to a disposable scratch copy at build time:

| Patch | Un-comments | Comments out |
|---|---|---|
| `board-distro-v3-s3.patch` | `I2C_SDA 8` / `I2C_SCL 9` (`:31,32`), `servoPins {4,5,6,7,10,11,12,13}` (`:101`) | S2 Mini `I2C_SDA 33` / `I2C_SCL 35` (`:39,40`), `servoPins` (`:110`) |
| `board-distro-v1-esp32.patch` | `I2C_SDA 21` / `I2C_SCL 22` (`:35,36`), `servoPins {15,2,23,19,4,16,17,18}` (`:107`) | S2 Mini `I2C_SDA 33` / `I2C_SCL 35` (`:39,40`), `servoPins` (`:110`) |

Each is 2 hunks and 12 changed lines — the minimum that expresses the intent.
`s2mini` needs no patch: the checked-in upstream default *is* the S2 Mini config.

**The patches are stored with CRLF**, because the upstream sources are CRLF
(1137/1137 lines). `.gitattributes` now carries `*.patch -text` so EOL
normalization cannot rewrite the `^M` inside their context lines and make
`git apply` reject them. Generating the diffs also required
`git -c core.autocrlf=false`; without it this host's `autocrlf=true` silently
normalized both sides and produced an LF patch that would not apply.

**Post-patch verification.** Every build re-derives the active `servoPins` array
and `I2C_SDA`/`I2C_SCL` values from the patched source (ignoring commented-out
lines) and asserts them against the matching board entry in
`hardware/hardware-map.json`. A patch that applies cleanly but produces the
wrong pins is worse than one that fails loudly, and this is not hypothetical —
see §5.

---

## 5. A silent `git apply` no-op, caught by the pin assertion

Worth recording because it would have produced three plausible-looking binaries
that were all secretly the same board.

The scratch sketch lives under `tools/`, i.e. **inside this repository's work
tree**. `git apply` resolves patch paths against the enclosing work-tree root,
so from the scratch directory it looked for
`<repo-root>/sesame-firmware-main.ino`, printed `Skipped patch`, and **exited
0**. `git apply --check` also passed. Both S3 and V1 therefore "applied" their
patch and then compiled the unmodified S2 Mini configuration.

The hardware-map assertion caught it immediately:

```
[patch] applied board-distro-v3-s3.patch (sha256 05567eec58abb6ec...)
[verify] MISMATCH vs hardware-map.json board distro-v3
  source: servoPins=[1,2,4,6,8,10,13,14] SDA=33 SCL=35
  map:    servoPins=[4,5,6,7,10,11,12,13] SDA=8 SCL=9
```

Fixed by giving the scratch sketch directory its own throwaway git repository
(`git init -q`) before applying, so it becomes the innermost work-tree root and
`-p1` paths resolve to the copied files; the `.git` directory is removed again
straight after. The driver now also treats `Skipped patch` in git's output as a
failure regardless of exit status, since exit 0 cannot be trusted here.

---

## 6. Build results

All three profiles build clean. Artifacts and manifests are in
`firmware/artifacts/<profile>/` (gitignored).

### `s2mini` — ESP32-S2, active upstream configuration

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `.elf` | 15 506 292 | `5436d303bfa9fb1458c2c03b5154f27fbf8c32cfefd10c556d2c61e9849eedfd` |
| `.bin` | 1 120 736 | `e263e7c9550d9a20db81f0a59a77e47b70642acb1de5bdbcec48dc33188a29f1` |
| `.map` | 18 072 302 | `eac008fa131a64267f8f5807b7b2919e76b2393fa5ecf5d178ca953ee9057a43` |
| `.bootloader.bin` | 20 976 | `e1f274303f354d7f031915e981af5086c545c115f147c15c0bec55b26242b78e` |
| `.partitions.bin` | 3 072 | `148b959cbff1c38aa8e1d5c0ba9d612c54997b945e56a63f41223eef650653a1` |
| `.merged.bin` | 4 194 304 | `7ac0401cdc77428323ed04d34b07621f09d0d82896797dc9eaa4a80820599a17` |

Flash **1 120 590 / 1 310 720 (85.5 %)** · RAM **79 632 / 327 680 (24.3 %)**

### `distro-v3-s3` — ESP32-S3

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `.elf` | 15 512 464 | `b11fe2da9dbdd5cf445c72cb2bf72a05cf2674a27acea13d66bfd493b5cfe5de` |
| `.bin` | 1 119 520 | `952111713910bf13f6c96cec1fd363a2b1eb27c786985dc5ebe38985e6e71662` |
| `.map` | 19 627 191 | `885e63731300a870bccbce510d3b7f6779005197a5a118a841e53c6293b183b2` |

Flash **1 119 376 / 1 310 720 (85.4 %)** · RAM **51 464 / 327 680 (15.7 %)**

### `distro-v1-esp32` — ESP32 (LX6), also the Espressif-QEMU fallback target

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `.elf` | 14 700 684 | `c8a895b06531faa9866d4d7dd09b9b1783c906fde184e683dd66314ed0d3282c` |
| `.bin` | 1 141 552 | `a300f5136f9376cbd5bbfdca65614c93916f4eeff07a44f532f8272e3d42b4c0` |
| `.map` | 18 377 295 | `ea9da0f38e14d01c1e71d05df51e8375afd95a272644ba9d1dc0b5c054fb34da` |

Flash **1 141 406 / 1 310 720 (87.1 %)** · RAM **52 512 / 327 680 (16.0 %)**

The S2 Mini's RAM figure is ~28 KB higher than the other two. Not investigated;
noted in case it matters to a memory model later.

Each `build-manifest.json` records profile, FQBN, decomposed board options, the
verified pin/I²C configuration, upstream commit, patch file + its SHA-256,
arduino-cli version, core version, every library version, the compiler binary
path and version, the resolved build flags, per-artifact size and SHA-256, the
scratch and build paths, `SOURCE_DATE_EPOCH`, build duration and timestamp.

---

## 7. Determinism — PASS, bit-for-bit

Procedure: build, record hashes, `--clean` (which deletes the entire scratch
tree: sketch copy *and* arduino-cli build directory), rebuild, compare.

| Profile | Verdict |
|---|---|
| `s2mini` | **byte-identical** (`.elf` and `.bin`), reproduced 3× |
| `distro-v3-s3` | **byte-identical** `.elf` |
| `distro-v1-esp32` | **byte-identical** `.elf` |

s2mini ELF SHA-256 `5436d303…9eedfd` on every run, including runs separated by
changes to the arduino-cli config file and a wipe of the compilation cache.

### Why it is deterministic — the interesting part

The usual ESP-IDF culprit is the **application descriptor** (`esp_app_desc_t`),
which embeds `__DATE__` and `__TIME__`. It is present here, at offset `0x20` of
the app image. Dumping it from `s2mini`'s `.bin`:

| Field | Value |
|---|---|
| `version` | `ee57070` |
| `project_name` | `arduino-lib-builder` |
| `time` | `10:53:08` |
| `date` | `Jul 20 2026` |
| `idf_ver` | `v5.5.5` |

Those timestamps are **Espressif's**, not ours. The Arduino-ESP32 core ships
ESP-IDF as *precompiled* static libraries, so the `__DATE__`/`__TIME__`
expansion happened once, on Espressif's build machine, on 2026-07-20 — and is
now a frozen constant inside `esp32s2-libs@3.3.11`. Pinning the core version
therefore pins the timestamp. This is a property of the pin, not luck: it would
break if the core version floated, which is one more concrete reason `latest` is
banned here.

Two further sources were controlled deliberately rather than being found benign
by accident:

- **Build paths.** The scratch sketch and build directory are at a *stable*
  repo-relative path (`tools/arduino-data/scratch/<profile>/`), not a per-run
  temp dir. Absolute paths do appear in the binary — the `.map` cross-reference
  table is full of them — so a randomised temp directory would have made every
  build differ for an entirely uninteresting reason.
- **Environment.** The driver pins `TZ=UTC`, `LC_ALL=C` and
  `SOURCE_DATE_EPOCH=1700000000`.

**Verification bonus:** the app descriptor's `app_elf_sha256` field (offset
`0x90` within the descriptor) reads
`5436d303bfa9fb1458c2c03b5154f27fbf8c32cfefd10c556d2c61e9849eedfd` — exactly the
`.elf` SHA-256 recorded above. The flashable image is cryptographically bound to
the ELF, so a Renode run can prove which build it loaded without trusting our
bookkeeping.

**Caveat, stated honestly.** This is same-machine, same-toolchain reproducibility.
It is what the gate asked for and it is what the reproducibility ledger needs. It
is *not* a claim of cross-machine reproducibility: the absolute build path is
embedded, so a different checkout location will produce a different ELF. If
cross-machine reproducibility is ever needed, `-ffile-prefix-map` on the stable
scratch path is the lever, and this is the reason it would be needed.

---

## 8. Build warnings

**The default build emits zero diagnostics — because the platform suppresses
them all.** `platform.txt` sets `compiler.warning_flags=-w`, which lands in both
`compiler.c.flags` and `compiler.cpp.flags`. Upstream Sesame firmware is
therefore compiled with every warning off, and `arduino-cli --warnings default`
does not change that.

A probe build at `--warnings all` (`-Wall -Wextra`) was run to see what is
hidden. Result: **3 warnings, all `-Wunused-variable`, all inside ESP32Servo
3.0.9, none in Sesame source.**

- `ESP32Servo.cpp:58:20` — `'TAG' defined but not used`
- `ESP32PWM.cpp:18:20` — `'TAG' defined but not used`
- `ESP32PWM.cpp:338:21` — `unused variable 'ret'`

All benign. `ESP32PWM.cpp:338`'s discarded `ret` is a dropped return value in
`ESP32PWM::attachPin()`, worth a glance if servo attach ever misbehaves under
emulation, but it is not an error.

The probe was thrown away; the shipped artifacts are the `default`-warning
builds. `-Werror=return-type` is on in both configurations.

### The undefined weak bitmaps (F4's finding), confirmed at binary level

F4 reported that `epd_bitmap_stand` and `epd_bitmap_defualt` are declared but
never defined. Confirmed, and it produces **no diagnostic at all** — not even at
`-Wall -Wextra`.

`face-bitmaps.h:52` declares every face via an X-macro:

```c
#define X(name) extern const unsigned char epd_bitmap_##name[] PROGMEM __attribute__((weak));
```

An undefined *weak* reference is legal and resolves to address 0 silently.
`nm` on the linked S2 ELF finds 47 `epd_bitmap*` symbols; `epd_bitmap_stand` and
`epd_bitmap_defualt` are **not among them** — no entry at all, where defined
bitmaps appear as `V` (defined weak object).

Consequence for emulation: the frame table for the `default` and `stand` faces
holds a null pointer, and `default` is the startup face
(`firmware/README.md:817`: *"`default` - The startup/fallback face"*). Any OLED
model must expect a read from address 0 during the very first frame render.

**Recorded, not patched**, per the phase-0 rule against fixing upstream bugs.
Note the misspelling `defualt` is upstream's own.

---

## 9. Deliverables

| Path | What |
|---|---|
| `scripts/setup-firmware-toolchain.ps1` / `.sh` | Idempotent portable install: arduino-cli (SHA-256-verified), generated config, pinned core, pinned libraries, and a hard assertion that neither machine-wide directory exists. |
| `scripts/build-firmware.ps1` / `.sh` | `<profile>` entry points. |
| `scripts/build-firmware.mjs` | The actual driver. Both wrappers delegate to it so the PowerShell and POSIX paths cannot drift, and so JSON manifest generation and SHA-256 hashing are not shell string-wrangling. Wrappers validate the profile name and check for node + arduino-cli before delegating. |
| `firmware/build/sketch.yaml` | The three declarative profiles. |
| `firmware/patches/board-distro-v3-s3.patch` | V3/S3 pin + I²C configuration. |
| `firmware/patches/board-distro-v1-esp32.patch` | V1/ESP32 pin + I²C configuration. |
| `firmware/artifacts/<profile>/` | `.elf`, `.bin`, `.map`, bootloader/partition/merged images, `build-manifest.json`, plus the raw compile stdout/stderr. |
| `reproducibility.json` | `arduinoCliVersion`, `arduinoEsp32CoreVersion`, `libraries`, and a 3-entry `builds[]`. Validates: `pnpm validate:reproducibility`. |

Build times on this host, after the core is installed: 113–141 s per profile.
The one-off core download is ~1.8 GB compressed, ~6.1 GB installed.

---

## 10. Open items

- **Cross-machine reproducibility is untested** and currently would fail, by
  construction (absolute build path embedded). §7 names the fix if it is wanted.
- **No hardware verification.** Nothing was flashed to a real S2 Mini, S3 or
  ESP32. The claim is "builds reproducibly", not "runs".
- **ESP32Servo #103 not independently reproduced.** Upstream's warning is
  recorded with provenance and honoured; we did not test it. §2.1.
- **The 1.2 MB app partition is 85–87 % full.** Instrumentation added by R6 eats
  into ~170–190 KB of headroom. Not a problem yet; would become one if
  instrumentation grows.
