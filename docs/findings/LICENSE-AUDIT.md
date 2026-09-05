# LICENSE-AUDIT — making this repository public

**Scope:** every file tracked in git (586 files), plus what the Tauri installer
redistributes. **Date:** 2026-09-05. **Upstream:** the Sesame Robot Project,
https://github.com/dorianborian/sesame-robot, Apache-2.0, pinned at
`401730514cefed738710d22303e84b0dcd6b76d0` (`firmware/upstream.pin.json`).

**I am not a lawyer and this is not legal advice.** It is an engineering audit:
what is here, what the licences say on their face, and what to add. Everything I
could not resolve is marked **[JUDGEMENT]** rather than answered.

Files created by this audit: `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`,
`docs/findings/PUBLIC-RELEASE-CHECKLIST.md`, and this file.
`docs/findings/` is gitignored-but-tracked, so this file and the checklist need
`git add -f`. `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md` are at the root
and add normally.

---

## 0. Headline

Three findings, in descending order of seriousness.

1. **The repository has no `LICENSE` and no `NOTICE`.** Every `package.json` and
   `Cargo.toml` already declares `Apache-2.0`, and the repo contains substantial
   Apache-2.0-derived material, but the licence text and the upstream
   attribution were never written down. Fixed by this audit — review the drafts.
2. **The installer redistributes GPL-2.0 QEMU with no licence text and no
   source.** This is about the installer, not the repository. `tools/` is
   gitignored and no QEMU byte is in git. It is nonetheless the only obligation
   here that is currently unmet in a way a recipient could notice. §3.
3. **Two Severity-1 hygiene leaks**, one of them a file literally containing a
   field named `secret`. §5.

Nothing found is a blocker for going public. Everything found is fixable in an
afternoon, and most of it in ten minutes.

---

## 1. Inventory of upstream-derived and third-party material

### 1a. Not in the repository at all — good, and worth stating

`reference/sesame-robot-main/`, `firmware/upstream/`, `firmware/artifacts/` and
`tools/` are all gitignored and contain **zero tracked files**. No upstream C++
source file, no upstream STL, no upstream CAD, no compiled firmware, no QEMU,
no Renode, no arduino-cli is in git. This is the single biggest reason the
repository is in good shape: the derivative material is all *extracted*, and the
originals are fetched.

### 1b. Tracked derivative works — verbatim reproduction of upstream expression

These reproduce upstream's creative expression, not merely facts about it. They
are the files that genuinely need the Apache-2.0 notice.

| File | Volume | Character | Recommendation |
|---|---|---|---|
| `apps/web/src/generated/face-bitmaps.ts` | 64,749 B; **45 base64 frames, ~46 KB of upstream bitmap data** | **(a) verbatim** — upstream's pixel art byte-for-byte, re-encoded from `firmware/face-bitmaps.h` | Listed in `NOTICE`. Add an explicit attribution line to the existing header (§2c). This is upstream's *artwork*, the strongest single claim in the repo. |
| `packages/sesame-sim/src/generated/choreography.ts` | 113,096 B; **4,510 lines, 21 movement functions, 395 steps** | **(a)-equivalent transcription** — upstream's choreography from `movement-sequences.h`, reformatted as data | Listed in `NOTICE`. Add attribution line to header. |
| `hardware/hardware-map.json` | 310,157 B; the same 395 steps plus **1,167 provenance citations**; 43 `code` fields (2 unique upstream lines); 22 `signature` | **(a) transcription + (b) fragments** | Listed in `NOTICE`. The upstream commit is already in `meta`. |
| `assets/sesame.glb` | 1,282,796 B | derived geometry, measured from 15 STL + 2 STEP files | Listed in `NOTICE`. Provenance already in `hardware/assets-inventory.json`. |

### 1c. Tracked extractions — short verbatim fragments, heavily attributed

| File | Volume | Character | Recommendation |
|---|---|---|---|
| `hardware/source-annotations.json` | 182,327 B; **263 verbatim single lines (141 unique)** in `text`/`startLineText`/`endLineText`, plus ~80 unique `signature` declarations | **(b)** — never contiguous; a span quotes only its first and last line | Listed in `NOTICE`. Already cites `file:line` for every one. Sufficient with the NOTICE in place. |
| `hardware/lessons.json` | 340,344 B; 114 `signature` fields, 47 unique upstream declarations; all prose is ours | **(b)** | Listed in `NOTICE`. |
| `apps/web/src/generated/source-annotations.ts` | 132,914 B | projection of the above; **no source text** — the text stays in gitignored `firmware/upstream/` and is sha256-verified in the browser | Listed in `NOTICE`. This design is why the repo is not worse off than it is. |
| `apps/web/src/generated/lessons.ts` (233,468 B), `architecture-graph.ts` (72,291 B) | projections | **(b)/(c)** | Listed in `NOTICE`. |
| `hardware/joint-map.json`, `assembly-map.json`, `assets-inventory.json`, `calibration.json` | — | **(c)** measurements and our own analysis, citing upstream | Listed in `NOTICE` for completeness. |
| All `hardware/*.schema.json` | — | **(c)** ours | No action. |

### 1d. `firmware/patches/*.patch` — the "changed files" notice, already written

| Patch | Total | Upstream text | Ours |
|---|---|---|---|
| `telemetry-instrumentation.patch` | 228 ln | 25 ln (24 context + 1 removed) | **197 ln**, all ours |
| `board-distro-v1-esp32.patch` | 38 ln | ~34 ln — the 7 `+` lines are the same upstream lines with `//` toggled | ~0 original |
| `board-distro-v3-s3.patch` | 48 ln | ~44 ln, same | ~0 original |

**These patches are the cleanest possible Apache-2.0 §4(b) compliance for the
firmware.** A unified diff against a named commit states exactly what changed and
where — more precisely than any prose notice could. `NOTICE` says so explicitly.
No change needed to the patches themselves.

`.gitattributes` deliberately stores them with `-text` so upstream CRLF context
survives. Leave that alone.

### 1e. `docs/**` — quotation, not copying

Every fenced C/C++ block in tracked docs was enumerated (22 blocks).

* **Largest contiguous verbatim upstream block anywhere in tracked docs: 9 lines**
  (`docs/findings/V1-behaviour-model.md:66-76`, the body of `delayWithFace()`).
* Next largest: 8 lines (`EXP6-oled.md:51-60`), then 4+4
  (`GATE-B-servo-extraction.md`), 3+3 (`R6-R7-telemetry-bridge.md`), 1
  (`F3-firmware-build.md:457`). **~30 upstream lines total across 5 files.**
* The other 17 blocks are Adafruit, ESP-IDF, QEMU, or our own code.
* `docs/findings/F4-doc-drift.md` quotes upstream README prose: ~10 quotations,
  one clause to one sentence each, **~15–20 lines total**, every one attributed
  with `firmware/README.md:<line>` — textbook quotation for criticism, inside a
  359-line document that is otherwise entirely original.
* **No `epd_bitmap` hex arrays or `PROGMEM` data appear anywhere in docs.**
  Verified by grepping for `0x??, 0x??, 0x` across `docs/`, `research/`,
  `hardware/`, `firmware/build/`, `reproducibility.json` — zero hits.

**Recommendation:** no change. The root `NOTICE` covers it.

### 1f. `docs/findings/assets/` — 49 PNGs

Only **four** render upstream firmware source on screen:

| Screenshot | Upstream source visible |
|---|---|
| `w8-source-outline-beside-code.png` | **~19 lines** of `movement-sequences.h` (85–103), including the whole `runWavePose()` body — the largest of the set |
| `l4-source-explorer-wave.png` | **~13 lines** of `movement-sequences.h` (83–95) + ~30 symbol names |
| `l4-source-teaching-notes.png` | 0 code lines; ~48 upstream symbol names and line numbers |
| `l4-source-integrity-refusal.png` | 0 code lines (it is the sha256-refusal panel) |

The other 45 are responsive-layout, 3D-pose, OLED, trace and architecture
captures with no source on screen. **Recommendation:** no change — ~30 lines of
Apache-2.0 code visible in screenshots is covered by the root `NOTICE`.

### 1g. `emulator/**/logs/` — checked, essentially clean

GDB line tables carry upstream line numbers and mangled symbol names
(`_Z5setupv+31`) but **no source text**. `ladder-*.ladder.json` carry ~10 unique
sub-line call fragments (`display.begin(SSD1306_SWITCHCAPVCC, 0x3C)`). UART
captures contain one recurring upstream runtime string,
`"HTTP server & Captive Portal started."` (~12 occurrences repo-wide). Renode
disassembly is 3 instructions of the Espressif boot ROM, not upstream firmware.
**No action** for licensing. See §5 for their *paths*, which are a separate
problem.

### 1h. `research/` — our own

`research/Sesame Lab_ …md` / `.pdf` and `docs/research/*` are original
analysis. **[JUDGEMENT]** if any of these were produced with, or contain output
from, a third-party research service whose terms restrict redistribution, that
is yours to check — I have no way to tell from the files.

---

## 2. Apache-2.0 §4, applied concretely

§4 conditions the right to redistribute a work containing Apache-2.0 material on
five things. Here is each, and exactly what closes it.

### 2a. §4(1) — "give any other recipients a copy of this License"

**Status: was missing. Now drafted.**

`LICENSE` at the repo root: a byte-identical copy of the canonical Apache-2.0
text, taken from upstream's own `LICENSE`
(sha256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`,
201 lines). The appendix is left as the standard unfilled boilerplate, which is
how the ASF itself ships it and what GitHub's licence detector expects; the
copyright statement belongs in `NOTICE`, not in the licence text.

The installer must carry it too — see §3, artifact list.

### 2b. §4(2) — "cause any modified files to carry prominent notices stating that You changed the files"

**Status: partially satisfied already, now made explicit.**

* For the **firmware**, `firmware/patches/*.patch` already state precisely what
  changed and where, against a named upstream commit. That is stronger than a
  prose notice.
* For the **derived data and generated modules**, every file already carries a
  `GENERATED FILE — do not edit` header naming its generator, its source, the
  upstream commit and often a sha256. §4(2) applies to *modified files*, and
  these are more accurately new files derived from upstream than modified copies
  of it — but the distinction is not worth arguing, so `NOTICE` carries an
  explicit **"NOTICE OF MODIFICATION"** paragraph listing every modification:
  re-encoding, extraction, geometry derivation, instrumentation, board changes,
  and TypeScript re-implementation.

### 2c. §4(3) — retain all copyright, patent, trademark and attribution notices from the Source form

**Status: nothing to retain, which is itself the finding.**

Upstream's four firmware files carry **no per-file copyright headers**, upstream
ships **no NOTICE file**, and upstream's `LICENSE` appendix is unfilled
boilerplate (`Copyright [yyyy] [name of copyright owner]`). There is therefore
no upstream copyright line to reproduce. `NOTICE` attributes the *project* and
its repository URL and records this explicitly, with an instruction to add an
upstream copyright line verbatim if one is ever published.

**Do the generated headers suffice on their own?** No — and this is the one
place I would change a file. A header that says

> Source: `firmware/face-bitmaps.h` / sha256 … / Generator: …

documents **provenance** (where the bytes came from) but not **licence** (under
what terms you may use them). A reader of that file alone cannot tell it is
Apache-2.0. With the root `NOTICE` listing the file, the obligation is met; but
the cheap and unambiguous fix is one line per derived file:

```
 * Derived from the Sesame Robot Project (https://github.com/dorianborian/sesame-robot),
 * Apache License 2.0. See the repository NOTICE file.
```

Add it to:

* `apps/web/src/generated/face-bitmaps.ts` **[owned by T4 — do not edit; see §6]**
* `apps/web/src/generated/source-annotations.ts` **[T4]**
* `apps/web/src/generated/architecture-graph.ts` **[T4]**
* `apps/web/src/generated/lessons.ts` **[T4]**
* `packages/sesame-sim/src/generated/choreography.ts`
* `hardware/hardware-map.json`, `hardware/source-annotations.json`,
  `hardware/lessons.json` — as a `meta.license` / `meta.attribution` field

Because these are all generated, the line must be added to the **generator**
(`apps/web/scripts/build-*.mjs`, `packages/sesame-sim/scripts/build-choreography.mjs`,
`scripts/build-*.mjs`) and the files regenerated, or the `--check` modes will
fail. That is the work item, not hand-editing the outputs.

Alternatively, a single `NOTICE`-referencing line in each *directory* — e.g.
`apps/web/src/generated/README.md` and `packages/sesame-sim/src/generated/README.md`
— is a lighter-weight way to get the same effect without touching generators.
**[JUDGEMENT]** which of the two you prefer.

### 2d. §4(4) — if the Work includes a NOTICE file, include a readable copy of its attribution notices

**Status: upstream has no NOTICE, so nothing is inherited.** Sesame Lab's own
`NOTICE` is newly written, and once it exists, anyone redistributing *Sesame Lab*
must carry it forward. It must ship in the installer too (§3).

### 2e. §6 — trademarks

Apache-2.0 grants no trademark rights. Sesame Lab uses the name "Sesame"
throughout — in the product name (`"productName": "Sesame Lab"`), the bundle
identifier (`com.sesamelab.desktop`), every package name (`@sesame-lab/*`), and
the repository name.

§6 permits "reasonable and customary use in describing the origin of the Work",
which naming a derivative "Sesame Lab" plausibly is. `NOTICE` includes an
explicit trademark and non-endorsement paragraph on that basis.

**[JUDGEMENT — the only naming question worth your attention.]** If the upstream
author objects, or if you would rather not have to have that conversation, the
lowest-friction move is a courtesy note to the upstream project before you flip
the repo public — "I built a derivative teaching emulator, here's the NOTICE,
tell me if the naming bothers you". That is a social fix, not a legal one, and
it is usually the whole of it. Renaming later is cheap now and expensive after
the app is on a child's desktop.

---

## 3. QEMU — the separate and more serious question

**This is about the installer, not the repository.** No QEMU byte is tracked in
git; `tools/` is gitignored. Publishing the repository creates no QEMU
obligation whatsoever. Shipping `Sesame Lab_0.1.0_x64-setup.exe` to anyone
does.

### 3a. What is pinned, and what licence it carries

* Pinned release: **`esp-develop-9.2.2-20260417`**, hard-coded as the default in
  `emulator/qemu/fetch-qemu.mjs` with an explicit "never `latest`" comment.
* Asset: `qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-x86_64-w64-mingw32.tar.xz`,
  from `https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417`,
  verified against Espressif's own published SHA-256 manifest from the same
  release. **That verification is what makes the source correspondence
  defensible** — you can prove which release your binary came from.
* Binary reports: `QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)`,
  `Copyright (c) 2003-2024 Fabrice Bellard and the QEMU Project developers`.
* Licence: **GPL-2.0.** Source:
  `https://github.com/espressif/qemu/blob/esp-develop-9.2.2-20260417/LICENSE`,
  which is QEMU's own and states "The QEMU emulator as a whole is released under
  the GNU General Public License, version 2." Parts are BSD/MIT and libfdt is
  dual BSD/GPL, but **the whole is GPL-2.0** and that is the term that governs
  redistribution of the linked executable.
* **The Espressif release notes make no licensing, source-availability or
  redistribution statement at all.** Checked directly. Espressif's own terms do
  not help here — there are none.
* **The distributed Windows archive contains no licence text.** Verified: 18
  entries, no `LICENSE`, no `COPYING`, no `NOTICE`. If you redistribute, you
  supply the licence text or nobody gets one.

### 3b. Scope: spawned, not linked — confirmed across the tree

Verified independently:

* `src-tauri/src/qemu/` builds a `Command` and spawns the executable;
  `src-tauri/src/supervisor.rs` is only the Tauri adapter over it, resolving the
  path via `resources::resolve(app, resources::QEMU_EXE)`. Communication is a
  TCP socket to UART0.
* `src-tauri/Cargo.toml` has five dependencies — `tauri`, `dunce`, `serde`,
  `serde_json`, `windows-sys` — and no `links`, no `build.rs` linkage, no
  `cc`/`bindgen`. `build.rs` only reads `tauri.conf.json` to generate a resource
  manifest.
* The archive's `include/{fdt,libfdt,libfdt_env}.h` and `lib/libfdt.a` are
  present on disk but are **not** in `bundle.resources` (T2 ships only
  `bin/qemu-system-xtensa.exe` and `share/qemu/*.bin`) and nothing compiles
  against them.

**Consequence:** the obligation attaches to the QEMU binary you redistribute,
not to Sesame Lab's Apache-2.0 source. This "aggregation, not derivation"
reading of separate processes is standard and widely relied on. **It is a
reading, not a certainty** — the FSF's own position on process separation is
narrower than most of industry's. I flag it rather than assert it. Note also
that the reading is *strengthened* by the fact that Sesame Lab already runs fine
without QEMU (the simulator and bridge backends exist), so QEMU is genuinely an
optional co-distributed program rather than an integral part.

### 3c. What redistributing the binary obliges (GPL-2.0 §1 and §3)

* **§1** — keep the copyright notices, ship the licence text.
* **§3** — accompany the binary with corresponding source, by one of:
  * **§3(a)** complete corresponding machine-readable source, on a medium
    customarily used for software interchange; or
  * **§3(b)** a **written offer, valid for at least three years**, to supply it
    for no more than the cost of physically performing distribution; or
  * **§3(c)** pass along the offer you received — **unavailable here.** §3(c)
    requires that you received a §3(b) offer, and Espressif's release contains
    none. There is nothing to pass along. This is worth stating because
    "Espressif already provides the source" is the intuitive answer and it is
    not one of the three options.

**Redistributing someone else's pre-built binary differs in one specific way.**
You did not compile it, so you cannot certify from your own build that a given
source tree is the exact corresponding source. The tag is the best available
correspondence and it is what Espressif publishes the binary from — reinforced
by the SHA-256 check in `fetch-qemu.mjs`, which proves *which* release you have.
Building QEMU yourself removes the ambiguity completely and is the only way to
be certain. **[JUDGEMENT]** whether that certainty is worth a QEMU build
pipeline. For a project of this size I would say no, and rely on the tag.

### 3d. Do this to bundle — concrete artifact list

1. Add `licenses/QEMU-GPL-2.0.txt` — verbatim GPL-2.0 text.
2. Add `licenses/QEMU-LICENSE.txt` — QEMU's own `LICENSE` from the pinned tag
   (it explains which parts are BSD/MIT and is worth shipping alongside).
3. Add `licenses/QEMU-SOURCE-OFFER.txt` — the §3(b) written offer. Draft text is
   in `THIRD-PARTY-NOTICES.md` §C1. **You must supply: a contact address you
   will still read in three years, and the permanent source URL.**
4. Add `licenses/NOTICE`, `licenses/LICENSE` (Sesame Lab's own, for §4) and
   `licenses/THIRD-PARTY-NOTICES.md`.
5. Add `"../licenses": "licenses"` to `bundle.resources` in
   `src-tauri/tauri.conf.json`, so all of the above install alongside the app.
   **[T4 owns `src-tauri/` — hand this to them, do not edit it here.]**
6. **Surface it in the UI.** An "Open-source licences" entry that opens the
   `licenses/` folder or renders the files. The existing
   `apps/web/src/desktop/DesktopResources.tsx` panel already enumerates bundled
   resources and is the natural home. **[T4]** A licence a user cannot find is
   not accompanying the binary in any meaningful sense.
7. Extend `src-tauri/src/resources.rs`'s manifest and the
   `desktop-resources.test.ts` expectations so a missing licence file fails the
   build the same way a missing ROM does. **[T4]** This is the difference between
   compliance as an intention and compliance as an invariant — and it is exactly
   the pattern this project already uses everywhere else.
8. Attach `qemu-source-esp-develop-9.2.2-20260417.tar.gz` to the **same GitHub
   release as the installer.**

### 3e. Attaching source to the release vs. a written offer

**Attach the source to the same release. Do both, but let the attachment be the
primary mechanism.**

For a download-based distribution, putting the source tarball on the same
release page as the installer is the closest thing to §3(a) that exists: same
URL, same page, same act of distribution, no ongoing duty. Whether that
literally satisfies "accompany… on a medium customarily used for software
interchange" for a network download is **[JUDGEMENT] and genuinely contested** —
GPL-2 was drafted for physical media and GPL-3 §6(d) added explicit network
language precisely because GPL-2 lacked it. The common-practice reading is that
same-page availability is fine; I cannot tell you it is certain, and I have seen
careful projects disagree.

Which is why the **written offer is the cheap backstop**: it costs one text file
and covers you if the attachment reading is wrong, if you later ship the
installer somewhere other than that release page (a USB stick to your nephew, a
Discord upload), or if GitHub reorganises. Its cost is real but small: a
**three-year duty**, running from each recipient's receipt, to hand over that
source to *any third party* who asks — not just your users. In practice that
means an address you will still read in 2029 and a source tarball you keep
somewhere you control, not only on GitHub.

**One correspondence caveat.** The Espressif tag is the *upstream* source, which
does not include the MinGW cross-toolchain and build flags Espressif used to
produce the Windows executable. GPL-2's "complete corresponding source" for an
executable includes "the scripts used to control compilation and installation".
Espressif's build recipe is in its repository, so the tag arguably carries it —
**[JUDGEMENT]**, and one more reason the written offer is worth having.

### 3f. Bundle vs. fetch-at-first-run — the recommendation

Weighed on your actual concern: the install must not fail on a child's machine.

**Fetch-at-first-run fails in ways you cannot fix remotely:**

* **No network at first launch.** The single most likely failure. A laptop set
  up at a kitchen table, or a school device on a captive portal, gets a broken
  app on the one day enthusiasm is highest.
* **School or corporate proxy / TLS inspection.** `fetch-qemu.mjs` already
  documents that `raw.githubusercontent.com` intermittently fails TLS revocation
  checking *on your own build host* — you have already been bitten by exactly
  this class of failure, on a friendly network.
* **Antivirus.** An unsigned application downloading a 72 MB unsigned emulator
  executable and writing it to `%LOCALAPPDATA%` is close to a textbook signature
  for a dropper. Defender or a school endpoint agent may quarantine it silently.
  This is a materially worse look than shipping the same file inside an
  installer the user consciously ran.
* **117 MB on first run**, in the foreground, with a progress bar you must build
  and a resume path you must handle.
* **The pinned URL moving.** GitHub release assets can be re-tagged or deleted.
  A fetch-at-first-run app has a shelf life set by someone else's release page;
  a bundled one works forever.

Every one of those is a support call to you. The bundle has none of them.

**Bundling costs:** +75.4 MiB of installer (T2 already measured the whole payload
at 84.7 MiB installed — this is not a surprise, it is the plan), six files to
write once, and a three-year offer to honour.

**Ship the bundle.** The GPL-2.0 obligations here are entirely mechanical: write
the licence texts, write the offer, attach the source tarball, put a link in the
UI. There is nothing in them that requires opening your own code, changing your
Apache-2.0 licence, or restricting how you distribute. Trading an afternoon of
paperwork for an install that cannot fail on a network is the right trade for
this application.

The honest caveat: fetch-at-first-run has *no* GPL redistribution obligation at
all, because you never distribute the binary — the user downloads it from
Espressif. If you wanted the obligation to be zero rather than small, that is
how. I do not think a zero-obligation install is worth a first-run that can
fail.

### 3g. The other two bundled things

* **ESP32 boot ROM images** (`share/qemu/*.bin`, four files). Espressif silicon
  mask-ROM dumps. QEMU's own `LICENSE` explicitly carves firmware blobs out of
  the GPL ("separate programs … separate licenses"), and Espressif states no
  terms for them. **[JUDGEMENT — I could not resolve this and am flagging it
  rather than guessing.]** Espressif ships them publicly and expects them to be
  used with its QEMU, but expectation is not a grant. Mitigating: they are
  redistributed unmodified, from Espressif's own release, for their only
  intended purpose. Worth an email to Espressif if you want certainty; I would
  not hold the release for it.

* **The flash image** (`emulator/qemu/images/distro-v1-esp32-cli-oled.flash.bin`,
  4 MiB). Gitignored, so not a repository issue — but it **is** in the installer,
  and it statically links **LGPL-2.1-or-later** code: the arduino-esp32 Arduino
  API layer (`cores/esp32/Arduino.h` carries the LGPL-2.1-or-later grant) and
  **ESP32Servo 3.0.9** (grant in `src/ESP32Servo.h`; the library ships no
  `LICENSE` file at all). This is the **one non-permissive licence in the
  installer that is not QEMU**, and it is easy to miss because the flash image
  looks like data.

  LGPL-2.1 §6 allows static linking on condition that a recipient can relink
  against a modified library. You are unusually well placed to satisfy this:
  `firmware/upstream.pin.json` pins the source, `firmware/build/sketch.yaml`
  pins the core, every library version and the full FQBN,
  `firmware/patches/*.patch` are the modifications, and
  `scripts/build-firmware.{mjs,sh,ps1}` performs the build. A recipient has a
  complete, reproducible relink path. **State that explicitly in
  `THIRD-PARTY-NOTICES.md` and ship the LGPL-2.1 text** — done in the draft.
  **[JUDGEMENT]** whether that discharges §6 to your satisfaction; the clean
  escape hatch, if not, is to build the flash image at first run from the pinned
  inputs instead of bundling it.

---

## 4. Other third-party — committed / fetched / bundled

Full detail in `THIRD-PARTY-NOTICES.md`. Summary:

* **Committed:** nothing third-party. The repository contains no vendored
  dependency of any kind.
* **Fetched at build time, never redistributed:** arduino-cli (**GPL-3.0** — the
  strongest copyleft in the toolchain, and completely irrelevant because it never
  ships), Renode (MIT), the ESP32-S2 ROM ELF, and every pnpm/cargo package.
* **Bundled in the installer:** QEMU (GPL-2.0), the ESP ROM blobs (unstated),
  the flash image (Apache-2.0 + **LGPL-2.1** + BSD + MIT), the Vite web bundle
  (MIT throughout), and the Rust/Tauri binary (MIT / Apache-2.0).

**JS dependency tree, fully enumerated:** 153 unique packages — 128 MIT, 14 ISC,
4 Apache-2.0, 4 BSD-3-Clause, 2 Apache-2.0-OR-MIT, 1 CC-BY-4.0 (`caniuse-lite`,
build-time browser data, does not reach the bundle). **No copyleft and no
unlicensed package anywhere.** `@xyflow/react`, `three`, `@react-three/fiber`,
`react`, `react-dom`, `ws` all confirmed MIT from the installed tree. MIT does
require the notice to travel with the bundled copy — so generate an attribution
file at build time and ship it under `licenses/`.

**Rust: not exhaustively enumerated — the one gap in this audit.**
`src-tauri/Cargo.lock` has 431 packages; direct dependencies are all
MIT-OR-Apache-2.0. The lockfile is cross-platform and includes LGPL-adjacent
`gtk`/`webkit2gtk`/`soup3` bindings for Linux and `objc2-*` for macOS, none of
which compile into a Windows build. **Run `cargo about generate` against the
Windows target and commit the result** rather than taking my word for it.
`Cargo.lock` is otherwise clean: every `source` is crates.io, no `git+`, no
`path` overrides.

**Non-permissive licences in scope, all together:** GPL-2.0 (QEMU, bundled),
LGPL-2.1-or-later (arduino-esp32 core + ESP32Servo, bundled inside the flash
image), GPL-3.0 (arduino-cli, never redistributed), CC-BY-4.0 (`caniuse-lite`,
build-time only). That is the complete list.

---

## 5. Public-repo hygiene

### 5a. SEVERITY 1 — fix before flipping public

**1. `Projectssesame-robot-emulatortoolsarduino-datadata/inventory.yaml`** — a
tracked file containing an arduino-cli installation identity:

```yaml
installation:
    id: <rotated-id>
    secret: <rotated-secret>
```

Two problems. The `secret` is a stable machine-scoped installation credential —
low blast radius (it is a telemetry identifier, not an auth token) but it is
labelled `secret` and it should not be public. And the *directory name itself*
is a corrupted path join of `C:\Projects\sesame-robot-emulator\tools\arduino-data\data`
with the separators eaten — a script wrote `$REPO$TOOLS...` without separators.
`git check-ignore` confirms it is **not ignored**; the `tools/` rule missed it
precisely because the path was mangled.

**Recommendation:** `git rm -r --cached` the directory, delete it from disk, and
add a `.gitignore` guard. **[JUDGEMENT]** it is in git history, so a strict
reading says rotate — but rotating an arduino-cli installation id means deleting
`inventory.yaml` from the real `tools/arduino-data/data/` and letting arduino-cli
regenerate it, which costs nothing. I would do that. **Reported, not acted on**
— per your instruction I have not deleted or unstaged anything.

**2. Five Renode logs leak the Windows username and an agent session UUID.**
`emulator/renode/tests/logs/r4-{asm,regs,resetstate,setreg,cpu-help}.log`,
lines 4–5 of each. Verbatim from `r4-asm.log:5`:

```
[INFO] Including script(s): <local-path>\AppData\Local\Temp\claude\C--Projects-sesame-robot-emulator\<session>\scratchpad\asm.resc
```

This discloses the Windows account name `<user>`, the `%LOCALAPPDATA%\Temp`
layout, a Claude Code session UUID, and that an AI agent scratchpad drove the
run. **These five files are the only place `<user>` appears in any tracked file**
(confirmed by `git grep -l <user>`), and they are exactly what a
`ts|mjs|json|rs|md`-scoped scan misses.

**Recommendation:** rewrite lines 4–5 in each to a placeholder such as
`<scratch>/asm.resc`. These are evidence logs, so note the redaction inline
rather than silently editing. **[JUDGEMENT]** whether `<user>` matters to you at
all — it is your own first name and your commits are already signed
`Eric Zimmerman <<user>zim@gmail.com>`. The session UUID and the agent path are
the parts I would remove regardless.

### 5b. SEVERITY 2 — machine paths, no identity

`C:\Projects\sesame-robot-emulator` and `C:\Program Files\Renode` appear across:
`reproducibility.json` (15 occurrences, baked into recorded compiler flags),
`emulator/qemu/logs/ladder-{dio,nowifi,s3}.lines.log` (22 hits each — the
noisiest), `ladder-*.ladder.json`, `ladder-dio.gdb{,.log}`, `ledc.json`,
~17 Renode logs, and several docs
(`R1-renode-capability-audit.md`, `ADR-0002`, `phase-0-…md`, `GATE-A`,
`PHASE-0-SUMMARY`, `R2`, `R4`). Also
`docs/findings/assets/{exp8-browser,v3-v4-browser}-capture.json:4` record
`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`.

No username, no hostname. This is cosmetic, not privacy. **Recommendation:**
leave it. These are evidence artifacts whose value is that they are unedited,
and rewriting them weakens the reproducibility story this project is built on.

On your explicit question about **`reproducibility.json` host fields**: it
records `"os": "Windows 11 Pro 10.0.26200"` (an OS build string, not a machine
identity) and 15 absolute `C:\\Projects\\...\\tools\\arduino-data\\...` paths
inside recorded compiler command lines. **No hostname, no username, no MAC, no
serial.** Harmless as-is.

### 5c. SEVERITY 3 — a personal detail, entirely your call

`docs/plans/phase-5-tauri-desktop-app.md:5,63,151,182,189` and
`docs/findings/T2-tauri-resources.md:346` describe the project's purpose as
building an app for **"the user's nephew"**. That is a family-relationship
disclosure about a minor, in a repository you are about to make public. Nothing
identifies the child — no name, no location, no photo — and
`T2-tauri-resources.md:260` uses `C:\Users\nephew\…` only as a hand-written
illustrative path.

**Recommendation:** it is harmless and it is also the most human thing in the
repository. **[JUDGEMENT]** — I would keep it, but you may prefer "a young
learner". Reported, not changed.

### 5d. Clean — explicitly checked and found nothing

Zero email addresses in any tracked file (your address appears only in commit
metadata, sole author throughout, which is expected and fine). No hostnames or
NetBIOS names. No MAC addresses. No API keys, bearer tokens or `Authorization`
headers — every other `secret`/`token` hit is C++/TS lexer terminology or CSS
design tokens. No SSIDs or Wi-Fi passwords: upstream's `.ino` is gitignored, so
`AP_SSID`/`AP_PASS` *values* were never in the repo; only upstream's own public
default AP name `Sesame-Controller` appears. Private-IP hits are all legitimate
subject matter (`192.168.4.1` is the arduino-esp32 SoftAP default;
`192.168.1.20` / `10.0.0.5` are deliberate negative-case test fixtures). No
ngrok, no tailscale. `pnpm-lock.yaml` and `src-tauri/Cargo.lock` are clean — no
private registries, no `path`/`git+`/`file:` deps. Names other than yours are
all upstream/dependency handles (`dorianborian`, `espressif`, `madhephaestus`,
`renode`, `rust-lang`).

**Screenshots: no personal exposure in any of the 49.** All are headless-Edge
viewport captures (`scripts/capture-web-screenshots.mjs:667` passes
`--headless=new`), so there is no browser chrome, no URL bar, no tabs, no
bookmarks, no title bar, no taskbar, no clock, no other application, no local
path and no username in any frame. Every path-looking string on screen is a
repo-relative source citation.

### 5e. Missing files a public repo wants

There is **no `README.md`, no `CONTRIBUTING.md`, and no `CODE_OF_CONDUCT.md`** at
the root. Not a licensing issue, but the README is where the Apache-2.0 §4(2)
"we changed things" statement and the upstream relationship most naturally
appear, and it is the first thing a stranger sees. Worth writing before the repo
is public.

---

## 6. For T4 (`apps/web/`, `src-tauri/`) — reported, not edited

Per the constraint, I read these and changed nothing:

1. `src-tauri/tauri.conf.json` needs `"../licenses": "licenses"` added to
   `bundle.resources` (§3d.5).
2. `src-tauri/src/resources.rs` + `apps/web/src/__tests__/desktop-resources.test.ts`
   should be extended so a missing licence file fails the build, matching how
   the ROM and image resources are already treated (§3d.7).
3. `apps/web/src/desktop/DesktopResources.tsx` is the natural home for an
   "Open-source licences" affordance (§3d.6).
4. Four generated modules under `apps/web/src/generated/` want a one-line
   attribution in their headers — added to the **generators** in
   `apps/web/scripts/build-*.mjs`, not the outputs (§2c).

## 7. What is genuinely still your call

* Whether "Sesame Lab" as a name is comfortable, and whether to give upstream a
  courtesy heads-up first (§2e).
* The three-year contact address for the GPL written offer (§3d.3).
* Whether to bundle the flash image or build it at first run, given LGPL-2.1 §6
  (§3g).
* The ESP boot-ROM blobs, whose terms I could not establish (§3g).
* Whether same-release source attachment satisfies "accompany" for a network
  download, or whether you want the written offer to carry the weight (§3e).
* Whether to build QEMU yourself for exact source correspondence (§3c).
* Removing `inventory.yaml` and redacting the five Renode logs (§5a).
* Keeping or generalising "the user's nephew" (§5c).
* Per-file attribution lines vs. per-directory `README`s in the generated
  directories (§2c).
