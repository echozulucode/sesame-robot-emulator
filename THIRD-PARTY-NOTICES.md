# Third-party notices

This file lists software that is **not** part of Sesame Robot Emulator and is
**not** licensed under Sesame Robot Emulator's Apache-2.0 licence.

It distinguishes three very different things, because only the last two create
redistribution obligations:

| Category | What it means | Obligation |
|---|---|---|
| **A. Committed** | The bytes are in this git repository | Repository must carry the licence |
| **B. Fetched at build time** | Downloaded by pnpm / cargo / a fetch script; never committed | Nothing for the repository; obligations transfer to whatever you ship |
| **C. Bundled in the installer** | Copied into the Sesame Robot Emulator desktop installer and given to a user | **Full redistribution obligations** |

Nothing in category A exists today other than material derived from the
Apache-2.0 upstream Sesame Robot Project, which `NOTICE` covers.

---

## C1. QEMU — Espressif fork — **GPL-2.0** — BUNDLED

| | |
|---|---|
| Binary | `qemu-system-xtensa.exe` (71,749,689 bytes) |
| Source project | https://github.com/qemu/qemu |
| Fork actually shipped | https://github.com/espressif/qemu |
| Pinned tag | `esp-develop-9.2.2-20260417` |
| Reported version | `QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)` |
| Fetched by | `emulator/qemu/fetch-qemu.mjs` |
| Bundled by | `src-tauri/tauri.conf.json` → `bundle.resources` |
| Licence | GNU General Public License, version 2 |

The licence statement is `LICENSE` at the root of the Espressif fork
(`https://github.com/espressif/qemu/blob/esp-develop-9.2.2-20260417/LICENSE`),
which is QEMU's own and opens:

> The QEMU distribution includes both the QEMU emulator and various firmware
> files. These are separate programs that are distributed together for our
> users' convenience, and they have separate licenses.
>
> The following points clarify the license of the QEMU emulator:
>
> 1) The QEMU emulator as a whole is released under the GNU General Public
> License, version 2.
>
> 2) Parts of the QEMU emulator have specific licenses which are compatible
> with the GNU General Public License, version 2. Hence each source file
> contains its own licensing information. Source files with no licensing
> information are released under the GNU General Public License, version 2 …

**The distributed Windows archive contains no licence text at all.** Verified:
the tarball
`qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-x86_64-w64-mingw32.tar.xz`
holds 18 entries and none is a `LICENSE`, `COPYING`, or `NOTICE` file. If
Sesame Robot Emulator redistributes this binary, it must supply the GPL-2.0
text itself.

**Relationship to Sesame Robot Emulator's own code.** Sesame Robot Emulator
*executes* QEMU as a separate operating-system process (`src-tauri/src/qemu/`
builds a `Command` and spawns the `.exe`; `src-tauri/src/supervisor.rs` is the
Tauri adapter over it) and talks to it over a TCP socket. Nothing links against
QEMU. The archive's `include/` and `lib/libfdt.a` are not compiled, not
referenced by `src-tauri/Cargo.toml` or `build.rs`, and are deliberately
**not** in `bundle.resources` — only `bin/qemu-system-xtensa.exe` and
`share/qemu/*.bin` ship. On the usual reading, this keeps Sesame Robot
Emulator's own source outside the GPL's derivative-work scope and confines the
obligation to the QEMU binary itself. That reading is standard practice, not a
guarantee; see `docs/findings/LICENSE-AUDIT.md` §3.

### What redistributing it requires (GPL-2.0 §3)

Distributing a GPL-2.0 binary requires the corresponding source, by one of:

* **§3(a)** — accompany it with the complete corresponding machine-readable
  source, on a medium customarily used for software interchange; or
* **§3(b)** — accompany it with a **written offer, valid for at least three
  years**, to give any third party the source for no more than the cost of
  physically performing distribution; or
* **§3(c)** — pass along the offer you received. **This one is not available
  to Sesame Robot Emulator.** §3(c) is only for non-commercial distribution *and* only
  when you received the binary *with* a §3(b) offer. The Espressif release
  carries no such offer, so there is nothing to pass along.

Plus §1: keep the copyright notices and give every recipient a copy of the
licence.

**Note the asymmetry of redistributing someone else's pre-built binary.**
Sesame Robot Emulator did not compile this executable, so Sesame Robot Emulator
cannot certify from its own build that the source at tag
`esp-develop-9.2.2-20260417` is the exact "corresponding source". The tag is
the best available correspondence and is what Espressif itself publishes the
binary from. Publishing a source snapshot of that exact tag alongside the
installer is the closest a redistributor can get to §3(a) without rebuilding.
Building it yourself removes the ambiguity entirely and is the only way to be
certain the correspondence is exact.

### Concrete artifacts to add

1. `licenses/QEMU-GPL-2.0.txt` — the verbatim GPL-2.0 text.
2. `licenses/QEMU-LICENSE.txt` — QEMU's own `LICENSE` file from the pinned tag.
3. **Both shipped inside the installer**, under `licenses/`, added to
   `bundle.resources` in `src-tauri/tauri.conf.json`, and reachable from the
   application's UI (an "Open-source licences" item — the existing
   `DesktopResources` panel is the obvious place). A licence a user never
   encounters is not "accompanying".
4. `licenses/QEMU-SOURCE-OFFER.txt` — the §3(b) written offer (see below),
   also shipped and also linked from the UI.
5. A `qemu-source-esp-develop-9.2.2-20260417.tar.gz` attached to the **same
   GitHub release as the installer**. Same download page, same act of
   distribution — this is the cleanest way to satisfy "accompany" for a
   download-based release, and it makes the §3(b) offer a belt-and-braces
   backstop rather than the primary mechanism.

### Written offer — what it must say

> Sesame Robot Emulator redistributes `qemu-system-xtensa.exe`, built from the Espressif
> fork of QEMU at tag `esp-develop-9.2.2-20260417`
> (https://github.com/espressif/qemu). QEMU is licensed under the GNU General
> Public License, version 2.
>
> For a period of **three (3) years** from the date you received this software,
> Sesame Robot Emulator will provide, to any third party who asks, the complete
> corresponding machine-readable source code for that version of QEMU, on a
> medium customarily used for software interchange, for no more than Sesame
> Lab's cost of physically performing the distribution. Write to
> \<a contact address you will still read in three years\>.
>
> The same source is also published at
> \<permanent URL of the source archive attached to the release\>.

The three-year clock and the contact address are the two parts a hobby project
most often gets wrong. Both need a decision from you.

---

## C2. ESP32 boot ROM images — **licence not stated** — BUNDLED

| File | Origin |
|---|---|
| `share/qemu/esp32-v3-rom.bin` | Espressif Systems |
| `share/qemu/esp32-v3-rom-app.bin` | Espressif Systems |
| `share/qemu/esp32c3-rom.bin` | Espressif Systems |
| `share/qemu/esp32s3_rev0_rom.bin` | Espressif Systems |

These are dumps of the mask ROM burned into Espressif silicon, shipped by
Espressif in its own QEMU release. QEMU's `LICENSE` explicitly carves firmware
blobs out of the GPL ("These are separate programs … they have separate
licenses"), and the Espressif release states no terms for them.

**This is an open question and I could not resolve it.** Espressif ships these
files publicly and expects them to be used with its QEMU, but "expects" is not
a licence grant. Flagged for your judgement in `docs/findings/LICENSE-AUDIT.md`
§3.

---

## C3. Sesame firmware flash image — **mixed, includes LGPL** — BUNDLED

`emulator/qemu/images/distro-v1-esp32-cli-oled.flash.bin` (4 MiB) is shipped as
a Tauri resource. It is gitignored, so it is not in the repository, but it *is*
in the installer. It is a compiled, statically linked image containing:

| Component | Version | Licence |
|---|---|---|
| The Sesame Robot Project firmware | commit `4017305…` | Apache-2.0 |
| Sesame Robot Emulator telemetry patch | — | Apache-2.0 |
| arduino-esp32 core (Arduino API layer) | 3.3.11 | **LGPL-2.1-or-later** |
| arduino-esp32 core (ESP-IDF components) | 3.3.11 | Apache-2.0 |
| ESP32Servo | 3.0.9 | **LGPL-2.1-or-later** |
| Adafruit GFX Library | 1.12.6 | BSD-2-Clause |
| Adafruit SSD1306 | 2.5.17 | BSD-3-Clause |
| Adafruit BusIO | 1.17.4 | MIT |

Evidence for the LGPL classifications, read from the installed sources:

* `cores/esp32/Arduino.h` — "Copyright (c) 2005-2013 Arduino Team … modify it
  under the terms of the GNU Lesser General Public License … version 2.1 …
  or (at your option) any later version."
* `ESP32Servo/src/ESP32Servo.h` — "Copyright (c) 2017 John K. Bennett …
  GNU Lesser General Public License … version 2.1 … or any later version."
  (ESP32Servo ships **no** `LICENSE` file; the grant is only in the headers.)

Versions are pinned in `firmware/build/sketch.yaml` and `reproducibility.json`.

**LGPL-2.1 §6 obligation.** These libraries are *statically linked* into a
single firmware binary. LGPL-2.1 §6 permits that, but on condition that
recipients can relink the work with a modified version of the library — in
practice, by supplying either the object files needed to relink, or a written
offer of them, plus the library source, plus a notice that the library is used
and covered by the LGPL.

**How to discharge it here, cheaply.** The whole firmware is reproducible from
committed inputs: `firmware/upstream.pin.json` pins the source commit,
`firmware/build/sketch.yaml` pins the core, every library version and the full
FQBN, `firmware/patches/*.patch` are the modifications, and
`scripts/build-firmware.{mjs,sh,ps1}` performs the build. Publishing that fact
prominently — plus the LGPL-2.1 text and the library sources or their pinned
download URLs — gives a recipient a complete relink path, which is the outcome
§6 is aiming at. State it explicitly rather than leaving it implicit in the
build scripts.

**Alternative that removes the obligation entirely:** do not bundle the flash
image; build it at install time or first run from the pinned inputs. That is a
larger change (it needs the Arduino toolchain on the user's machine) and is
probably not worth it — but it is the clean escape hatch if the LGPL condition
turns out to be awkward.

---

## C4. Web frontend bundle — **MIT** — BUNDLED

`apps/web/dist` is bundled into the installer as `frontendDist`. Vite compiles
these into the shipped JavaScript:

| Package | Licence |
|---|---|
| react, react-dom 19.2 | MIT |
| three 0.185 | MIT |
| @react-three/fiber 9.7 | MIT |
| @xyflow/react 12.11 | MIT |
| ws 8.18 | MIT |
| ajv, ajv-formats | MIT |

MIT requires the copyright notice and permission notice to be included in "all
copies or substantial portions of the Software", and a minified bundle is a
copy. Generate a combined attribution file at build time and ship it under
`licenses/` next to the QEMU texts.

Across the full resolved `pnpm` tree (153 unique packages): 128 MIT, 14 ISC,
4 Apache-2.0, 4 BSD-3-Clause, 2 Apache-2.0-OR-MIT, 1 CC-BY-4.0
(`caniuse-lite`, a build-time browser-data package that does not reach the
bundle). **No copyleft, and no unlicensed package, anywhere in the JS tree.**

---

## C5. Rust / Tauri — **predominantly MIT / Apache-2.0** — BUNDLED

`src-tauri/Cargo.lock` resolves 431 packages. Direct dependencies —
`tauri` 2.11.3, `serde`, `serde_json`, `dunce`, `windows-sys` 0.61 — are all
MIT-OR-Apache-2.0 dual-licensed. Sesame Robot Emulator's own crate declares
`license = "Apache-2.0"` in `Cargo.toml`.

**Not yet verified exhaustively.** `Cargo.lock` is cross-platform and includes
`gtk`, `webkit2gtk` and `soup3` bindings for Linux (the underlying system
libraries are LGPL, dynamically linked) and `objc2-*` for macOS. Sesame Robot
Emulator ships Windows only, so those are not compiled into what is distributed
— but that should be confirmed against the actual build, not assumed.

**Action:** run `cargo about generate` (or `cargo-license`) against the Windows
target and commit the generated attribution file. This is the one third-party
category in this document that has not been enumerated package-by-package.

---

## B. Fetched at build time — no repository obligation

| Tool | Fetched by | Licence | Redistributed? |
|---|---|---|---|
| arduino-cli | `scripts/setup-firmware-toolchain.*` | GPL-3.0 (with a commercial-licence exception) | **No** |
| arduino-esp32 core 3.3.11 | arduino-cli | LGPL-2.1 / Apache-2.0 | Only its compiled output, in the flash image — see C3 |
| ESP32Servo, Adafruit GFX / SSD1306 / BusIO | arduino-cli | see C3 | Only compiled output |
| Renode | `tools/renode/` | MIT (plus ~60 bundled component licences it ships itself) | **No** — research only, not in the installer |
| ESP32-S2 boot ROM ELF | `scripts/fetch-esp32s2-rom.mjs` | Espressif, terms not stated | **No** |
| pnpm / cargo registry packages | lockfiles | see C4, C5 | Compiled output only |

`tools/` is gitignored in full; none of these bytes are in the repository.
arduino-cli's GPL-3.0 is worth noting only because it is the strongest copyleft
anywhere in the toolchain — and it is never redistributed, so it creates no
obligation at all.
