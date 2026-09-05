---
task: "T6 — the installer, and the first run on a machine that has never seen this project"
phase: 5
status: complete
date: 2026-09-05
owns: src-tauri, justfile, scripts (one new check), licenses, apps/web (the panel wording only), docs/findings
plan: docs/plans/phase-5-tauri-desktop-app.md §5 T6, §9
follows: docs/findings/T5-packaged-honesty.md §6, docs/findings/LICENSE-AUDIT.md §3
---

# T6 — a thing you can hand to a child, and the paperwork that has to travel with it

**Done when:** it installs on a machine that has never seen this project — no
Node, no pnpm, no repo — and the nephew can double-click, press **wave**, and
watch the robot move. It does. §7 is that run, with the repository stripped from
`PATH` and the working directory set to an empty folder, and §4 is the wave.

`docs/findings/` is gitignored but tracked files inside it still commit. This
file needs `git add -f`.

---

## 1. NSIS, not MSI — and the reason is who is standing at the machine

`bundle.targets` was `"all"`, which on Windows meant both. It is now `["nsis"]`,
so `just tauri-build` produces exactly one artefact:

```text
src-tauri/target/release/bundle/nsis/Sesame Lab_0.1.0_x64-setup.exe   22,044,797 B   21.0 MiB
```

| | NSIS | MSI |
|---|---|---|
| install scope | **per-user**, `%LOCALAPPDATA%\Sesame Lab` | per-machine by default |
| administrator | **none** — the generated script emits `RequestExecutionLevel user` | UAC prompt |
| size | **21.0 MiB** | 31.0 MB (T2's measurement) |
| licence page before install | `MUI_PAGE_LICENSE`, and §3 puts a real document in it | possible, clumsier |
| uninstall | `uninstall.exe`, and Add/Remove Programs under HKCU | Windows Installer |

The deciding one is the second row. A child's machine is very often an account
without administrator rights, and a UAC prompt is a place where an installation
stops and a parent has to be found. Per-user needs nobody. The MSI is one flag
away — `pnpm exec tauri build --bundles msi` — and is the right artefact if this
is ever *deployed* by a school rather than double-clicked by the person using
it; `just tauri-build`'s comment says so.

**The payload, itemised:**

```text
22 bundled resources                          79,188,591 B   75.5 MiB
  qemu-system-xtensa.exe                      71,749,689
  QEMU share/ ROMs (4)                         1,697,876
  the flash image                              4,194,304
  hardware/*.json (7)                          1,456,986
  licences (9)                                    89,736     <- new in T6
sesame-lab-desktop.exe (Tauri + apps/web/dist) 10,206,208
installed payload                             89,478,318 B   85.3 MiB
```

T2 predicted 84.7 MiB; the licences and a slightly larger binary account for the
difference. Nothing unexpected got in.

## 2. The name and the icon

| | | |
|---|---|---|
| `productName` | `Sesame Lab` | the Start Menu entry, the window title, the Add/Remove Programs name, the install folder |
| window title | `Sesame Lab` | unchanged from T1, and the same string |
| `version` | `0.1.0` | left alone deliberately: `Cargo.toml`, the installer file name and every measurement T2–T5 recorded all say 0.1.0, and a version bump is a one-line change the person shipping this should make on purpose |
| `identifier` | `com.sesamelab.desktop` | unchanged; it names the WebView2 profile directory under `%LOCALAPPDATA%` — see §7 |
| `publisher` | `Sesame Lab` | now explicit rather than inherited from `Cargo.toml`'s `authors` |
| `copyright` | `Copyright 2026 Eric Zimmerman. Apache-2.0. Bundles QEMU under GPL-2.0 — see licenses/.` | taken from `NOTICE`, not invented; it is in the .exe's version resource |
| `category` | `Education` | |
| short/long description | written | the long one says *"nothing here is a physical robot and nothing here is a measurement"*, because the store blurb is a surface too |

Read back out of the installed machine:

```text
HKCU\...\Uninstall\Sesame Lab
    DisplayName     Sesame Lab
    Publisher       Sesame Lab
    DisplayVersion  0.1.0
    MainBinaryName  sesame-lab-desktop.exe
```

**The executable is still `sesame-lab-desktop.exe` and that is deliberate.**
Renaming it to `Sesame Lab.exe` would be tidier in one place and would break
four: `just tauri-resources`, `just tauri-emulator`, `just tauri-honesty` and
`findDesktopExe()` in the contract suite all name the binary. What a child looks
for is the Start Menu entry and the icon, and both say *Sesame Lab*.

### The icon is drawn, and the design constraint was 16 px

T1 §6 left Tauri's default logo. `src-tauri/icons/make-icon.mjs` (no
dependencies — `node:zlib` and eight lines of CRC) draws the source at
1024×1024, and `pnpm exec tauri icon` fans it out. It is the OLED face the
firmware actually draws, reduced to four shapes: a rounded square, a darker
screen, two eyes, a mouth. Colours are the app's own tokens.

The reason to say so is that the icon is *seen* at 16×16, and that is what was
checked rather than the 1024 preview. The shipped `.ico` decoded at its 16×16
entry:

```text
 +............+
 ..............
 ....OO..OO....      O = --observed #4ec9a0
 ....OO..OO....      + = --accent   #6e9ee6
 .....OOOO.....
 ..............
 +............+
```

Twelve face pixels of 192 opaque. `just tauri-install` asserts that count is
≥ 8, and §8 shows it refusing an icon whose face had gone. The iOS and Android
icon sets `tauri icon` also produced were deleted: the plan is desktop-only
(§8) and shipping unused assets invites the question of whether mobile works.

## 3. The licences, and where a recipient actually meets them

`docs/findings/LICENSE-AUDIT.md` §3: **QEMU is GPL-2.0, we bundle it, and the
Espressif tarball ships no licence text at all** — verified, 18 entries, none of
them a `LICENSE`. If Sesame Lab redistributes that binary, Sesame Lab supplies
the licence or nobody gets one.

Nine files install to `<install folder>\licenses\`, enumerated one by one in
`bundle.resources` (T2's rule: never a glob, always a full target path), so
`build.rs` puts each in the generated manifest and `--resource-report` fails if
one is missing or the wrong size. **A missing licence now fails the same way a
missing ROM does**, which is the audit's §3d.7 and the difference between
compliance as an intention and compliance as an invariant.

| Installed as | From | Why it is there |
|---|---|---|
| `licenses/README.txt` | new | the index, and the installer's licence page |
| `licenses/QEMU-GPL-2.0.txt` | gnu.org, verbatim | GPL-2.0 §1 |
| `licenses/QEMU-LICENSE.txt` | `espressif/qemu` at the pinned tag | says which parts are BSD/MIT and carves out the firmware blobs |
| `licenses/QEMU-SOURCE-OFFER.txt` | new | GPL-2.0 §3(b), three years |
| `licenses/LGPL-2.1.txt` | gnu.org, verbatim | the flash image |
| `licenses/FIRMWARE-LGPL-RELINK.txt` | new | LGPL-2.1 §6 — §3.2 below |
| `licenses/Sesame-Lab-LICENSE-Apache-2.0.txt` | the repo's `LICENSE` | Apache-2.0 §4(1) |
| `licenses/Sesame-Lab-NOTICE.txt` | the repo's `NOTICE` | Apache-2.0 §4(4) |
| `licenses/THIRD-PARTY-NOTICES.md` | the repo's file | MIT notices, the Rust/JS trees, the open questions |

The last three are bundled **from the repository root files themselves**, not
copies. `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md` are not mine to edit
and a copy would drift; the check in §7 asserts byte-identity, so if the root
files change and the installer is not rebuilt, it says so.

The two licence texts fetched from gnu.org were cross-checked against three
independent copies on this machine (the ESP32 toolchain ships GCC's and
binutils' `COPYING` and `COPYING.LIB`). Word-diffed, the only differences are
the FSF's own postal address being replaced by `<https://fsf.org/>` in the
current texts, and GCC's older copy saying "Library" where the current one says
"Lesser". The operative terms are identical.

### 3.1 What a recipient sees, in order

1. **Before a byte is written**, the installer shows `licenses\README.txt` as
   its licence page. It names Apache-2.0 for the app, GPL-2.0 for QEMU with the
   offer, LGPL-2.1 for the firmware image, and the one question the audit could
   not resolve — the ESP boot ROM blobs, whose terms Espressif states nowhere.
   (Verified in the generated `installer.nsi`: `!insertmacro MUI_PAGE_LICENSE`,
   skipped only for a `/S` silent install.)
2. **After installing**, `licenses\` sits beside the executable.
3. **A Start Menu entry, "Sesame Lab licences"**, next to the app's own, from
   `src-tauri/installer-hooks.nsh`. A licence in a folder nobody opens is not
   accompanying anything, and a year later nobody remembers where the app went.

**What is still missing, and it is named rather than implied:** an
"Open-source licences" item *inside the application window*. The audit asks for
it (§3d.6) and `apps/web/src/desktop/DesktopResources.tsx` is the natural home.
T6's remit in `apps/web/` is the panel wording and nothing else, so it is not
done. The three routes above are what carries the obligation today.

### 3.2 The LGPL relink path needed stating, not building

The 4 MiB flash image statically links **LGPL-2.1-or-later** code: the
arduino-esp32 Arduino API layer and ESP32Servo 3.0.9 (whose grant is only in its
headers — it ships no `LICENSE` file at all). §6 wants a recipient to be able to
relink against their own copy.

They already can, and `FIRMWARE-LGPL-RELINK.txt` is that fact written down:
`firmware/upstream.pin.json` pins the source commit, `firmware/build/sketch.yaml`
pins the core, every library version and the full FQBN,
`firmware/patches/*.patch` are the modifications,
`scripts/build-firmware.{ps1,sh}` performs the build, and
`emulator/qemu/build-qemu-images.mjs` turns it into the image. The file says
which line to change to substitute a library. Nothing was built for this; it was
already true and unstated.

### 3.3 The two blanks — **these are the user's and must not be invented**

```text
licenses/QEMU-SOURCE-OFFER.txt:45   [[FILL IN: a contact address that will still reach
                                     you three years after you give this software to anyone]]
licenses/QEMU-SOURCE-OFFER.txt:50   [[FILL IN: the permanent URL of the source archive
                                     qemu-source-esp-develop-9.2.2-20260417.tar.gz,
                                     published alongside the installer]]
```

`just tauri-install` prints both, by file and line, on **every** run — they are
not a comment buried in a text file. The offer itself says, in the installed
copy, that until they are filled in it names no one and the application must not
be given to anybody. An invented address is worse than no offer, because it
looks discharged and is not.

Two other things remain the user's, from the audit and unchanged by T6: whether
to attach `qemu-source-esp-develop-9.2.2-20260417.tar.gz` to the same release as
the installer (§3e recommends it, and the offer is the backstop), and the ESP
boot-ROM blobs whose terms nobody states (§3g).

## 4. T5's handoff: the panel line now says something reachable and true

T5 §6 found that `panel-desktop-simulator` had **no reachable state that renders
it**. Its condition was

```tsx
desktopSimulator={backendId === 'sim' && labProbe?.labHost === 'desktop'}
```

and `labProbe` is only ever set from `desktopSimulatorProbe()`, which is only
reached when `desktop.selectsSimulator` — permanently false since T4 pointed
`TAURI_EMULATOR_BACKEND` at `'qemu'`. So the packaged app rendered **nothing**
in the one state the line exists for: a reader who switches the packaged app to
the behavioural simulator. And the sentence it would have rendered — *"This
desktop build has no emulator yet"* — had been false since T4 shipped one.

Both halves are fixed, and they are the same fix:

```tsx
desktopSimulator={desktop.present && backendId === 'sim'}
```

> This desktop window is being driven by the **behavioural simulator** — a host
> model, not the emulator and not hardware. No firmware is executing.
> [change what drives this]

Every clause is true in both states that now reach it: a shipped build whose
reader chose the simulator, and a build with `TAURI_EMULATOR_BACKEND === null`
that opened on it. It does not say which of the two happened; it says what is
driving, what is not, and offers the backend switch. `labProbe` is no longer
consulted, because inside Tauri there is no origin to probe and it stays `null`
for the life of the window.

### What T5's assertions became — kept and strengthened, not deleted

| T5 | T6 |
|---|---|
| **absent** while the emulator drives, with the presence probe proved live by injecting a node with the same testid | unchanged, still asserted, negative control untouched |
| the branch is still in the JavaScript the executable serves | unchanged; the sentence it greps for is now `No firmware is executing` |
| **absent** while the packaged app's own simulator drives, recorded as a **note** | **present**, and asserted: laid out, naming the behavioural simulator, calling it a host model, denying *both* the emulator and hardware — and **refusing T1's sentence by name**, so re-introducing *"has no emulator yet"* fails the build |
| the claims that stood in for it — `SYSTEM: HOST MODEL`, every event attributed to `host-model`, `isPhysicallyObserved()` still 0 | unchanged, still asserted; they are the surfaces a reader reads |

That is the plan's original wording — *absent when the emulator is driving and
present when the simulator is* — reachable for the first time. Read out of the
installed application:

```json
"simulator": {
  "environmentLine": "SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE",
  "desktopSimulatorLinePresent": true,
  "desktopSimulatorLineText": "This desktop window is being driven by the behavioural
    simulator — a host model, not the emulator and not hardware. No firmware is
    executing. change what drives this",
  "counts": { "host-model": 37, "emulator": 0, "physical-robot": 0 },
  "physicallyObservedEvents": 0
}
```

`notes: []`. T5's one open gap is closed as an assertion rather than a paragraph.

**Still not closed:** there is no jsdom render of `TrustCard` with
`desktopSimulator: true`. T5 named that as the thing that would finish the job,
and it is a test in `apps/web/` rather than the panel wording, so it is still
named rather than written. The line is now rendered and read in the packaged
window, which is a stronger place to check it and a slower one.

## 5. `csp: null` is closed — T1 deferred it to T6 and here is what it cost

T1, T2, T3 and T4 each ended with *"`csp: null` is still `csp: null`, and T6
should not inherit it silently."* T1 was explicit that choosing one belongs with
T6 *against a packaged artefact*, because a policy that breaks an R3F worker or
a `blob:` texture at package time and not at dev time is exactly the failure T5
exists to catch.

The policy now shipped, read back off the running installed application's own
response headers:

```text
default-src 'self'; script-src 'self' 'sha256-TKMVEJXwKE9LDo8F9dXc3yxfeNJJ9IXfgcw7I4auJ0c=';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
media-src 'self' blob:; worker-src 'self' blob:; child-src 'self' blob:;
connect-src 'self' ipc: http://ipc.localhost data: blob:; object-src 'none';
base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

`fetch('https://example.com/')` from inside the window: **blocked**. The whole
a11y and honesty sweep runs clean under it, and `errors.length === 0` in the
packaged window is one of phase 14's assertions, so a policy that broke a
texture or a worker would fail the run rather than degrade the app quietly.

**It cost one thing, and it is worth reading before anyone reverts it.** Setting
a CSP makes `tauri-build` *parse and re-serialise* `index.html`, so the document
the executable serves is html5ever's rendering of Vite's: doctype upper-cased,
`<meta … />` closed as `<meta …>`, `crossorigin` written `crossorigin=""`,
inter-tag whitespace moved. Twenty bytes. T5's served-asset check compares the
window's bytes against `apps/web/dist` — and it failed, correctly, on the first
build.

The fix keeps the check's strength:

* the **JavaScript and CSS are still compared byte for byte**, and they carry
  the entire application; their names are Vite content hashes;
* `index.html` falls back to equality **after a normalisation that removes
  exactly those four differences** (`normaliseServedHtml`, exported and 6 lines);
* every run shows the normaliser a hand-written Vite/html5ever pair it must
  accept and **three real edits it must refuse** — a changed title, a changed
  script ref, a dropped element — plus a fourth check that two documents with
  different bundle names are not called the same.

The pair is written out by hand rather than produced by applying the
normaliser's own rules to the file, which would have graded it against itself:
failure mode number seven, written in advance.

## 6. First run on a child's machine

### 6.1 SmartScreen — expect it, do not fight it

Everything is unsigned, and this was checked rather than assumed:

```text
Sesame Lab_0.1.0_x64-setup.exe   NotSigned
sesame-lab-desktop.exe           NotSigned
qemu-system-xtensa.exe           NotSigned      <- Espressif's, also unsigned
```

An installer downloaded through a browser carries the Mark of the Web, and
double-clicking it will show a **blue** dialog:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.
> Running this app might put your PC at risk.
> App: Sesame Lab_0.1.0_x64-setup.exe   Publisher: Unknown publisher
> \[Don't run]

The least-alarming path — the whole of it — is: click **More info**, which
reveals a **Run anyway** button, and click that. There is no other step. It is
one dialog, once, for the installer; the installed application is launched from
the Start Menu and does not carry the Mark of the Web, so it does not repeat.

**Do not** right-click → Properties → Unblock as a matter of routine, do not
turn SmartScreen off, and do not add exclusions: the warning is about the
absence of a signature, not about anything the app does, and switching the
protection off costs far more than the click. If the person installing it would
rather not click past it, that is a reasonable answer and the right one for
them — signing is a separate decision (plan §8 puts it out of scope) and the
only thing that removes the dialog is an Authenticode certificate with enough
reputation, which takes money and time.

Windows Defender on this machine did **not** quarantine the unsigned 71 MB
`qemu-system-xtensa.exe` at any point, across five installs. T2 §8 flagged it as
a second, independent thing Defender might take an interest in; it did not here,
which is evidence and not a guarantee.

### 6.2 Offline

The installed application makes **no network connection of its own**. While it
was driving real firmware, the only TCP connections owned by it or its children
were the loopback pair between `sesame-lab-desktop.exe` and
`qemu-system-xtensa.exe` — the UART0 socket. The CSP refuses every remote
address, and `fetch('https://example.com/')` from the window is blocked. Every
resource it needs is inside the install: 22/22 present, checked from an empty
working directory with the repository stripped from `PATH`.

The honest caveat, which is in the shipped `README.txt` too: the window is drawn
by Microsoft's **WebView2 runtime**, which is part of Windows, and in one of two
observations it held three connections to Microsoft addresses on :443 while the
app was open. That is Windows doing what Windows does; nothing in Sesame Lab
asks it to. The first draft of the licence README said "no data leaves the
machine", which is a claim I could not support, and it was rewritten.

### 6.3 The ~28% boot panic, in the installed application

ISSUE-20260823-022 panics roughly a quarter of cold boots and the supervisor
retries past it. A silent multi-second freeze on first run reads as a hang, so
V7 and T4 both required the attempt counter to be visible. Sampled from the
**installed** copy, launch by launch, at 120 ms:

```text
--- launch 3 (a real panic) ---
  +0.7s  connecting  starting the bundled emulator
  +1.0s  connecting  booting real firmware — attempt 1 of 12, 0.3 s elapsed
  +3.3s  connecting  booting real firmware — attempt 2 of 12, 2.5 s elapsed · 1 boot(s)
                     panicked and were relaunched — ISSUE-20260823-022, a QEMU
                     cache-modelling bug this retries past rather than fixes
  +5.5s  connected   real firmware executing under QEMU · booted in 2205 ms after
                     2 attempt(s) · 1 boot(s) panicked and were relaunched — …
```

Three launches, one of them a real retry. The window never goes more than about
two seconds without the text changing, and it names the bug rather than saying
"please wait". A clean boot is `connected` at about 3.2 s.

`just tauri-install` also caught a three-attempt boot in its own selftest
(`booted in 1900 ms after 3 attempt(s)`), from the installed copy, which is the
same mitigation one layer down.

### 6.4 When something does fail, it says what and why

The three flags T2, T3 and T6 added to the binary all write a document and exit
non-zero, and the sentences are the ones a beginner can act on — *"not found. It
was configured as … in bundle.resources"*, *"a resource that is present at the
wrong size is worse than one that is absent"*, *"the installer did not place
licenses/QEMU-GPL-2.0.txt. A licence a recipient cannot find is not accompanying
the binary."* In the window, a boot that exhausts twelve attempts reports *"the
bundled emulator failed to boot"* with the panic text and the attempt count,
rather than an empty scene.

## 7. The acceptance test, run literally

`scripts/verify-install.mjs`, `just tauri-install`. It is a script rather than a
transcript because *"it installs on a machine that has never seen this project"*
is exactly the property that stops being true silently.

Every command it gives the installed application runs with **the repository
stripped out of `PATH`** (asserted, not assumed), with `NODE_PATH`, `PNPM_HOME`,
`CARGO_HOME` and friends deleted, and with the working directory set to a
**freshly created empty folder** that is inside neither the repo nor the install.
That is T2's empty-directory discipline, enforced instead of remembered.

```text
[install] installer  Sesame Lab_0.1.0_x64-setup.exe (21.0 MiB)
[install] target     ...\Temp\sesame-install-mtol6tlu\app   (did not exist)
[install] icon.ico: sizes 32/16/24/48/64/256, 16x16 has 12 face pixels of 192 opaque
[install] --resource-report, cwd ...\empty-cwd, repository stripped from PATH
[install] resources  22/22 present, 75.5 MiB, resourceDir ...\sesame-install-mtol6tlu\app
[install] --emulator-selftest (boots the bundled QEMU), cwd ...\empty-cwd
[install] emulator   booted in 2067 ms after 1 attempt(s), 1788 UART bytes, survivors 0
[install] uninstalling with uninstall.exe /S
[install] uninstalled: 0 file(s) left, no HKCU uninstall entry, 0 Start Menu entry(s)
          left, WebView2 profile removed
[install] 2 placeholder(s) in the installed licence texts …
OK    the installed application checks out — 0 problem(s)
```

Exit **0 / 1 / 2**, the same three codes `verify-packaged-honesty.mjs` uses and
for the same reason: *nothing was verified* must not read as *everything passed*.

### And the window, and the wave

`just tauri-honesty "<the installed exe>"` — T5 wired that lever for exactly
this — against the installed copy, with the repo present but the app resolving
everything through `app.path()` relative to itself:

```text
CDP target                http://tauri.localhost/            guard passed
served assets             index.html + index-Ohnn2SUG.js + index-DmCj8ILI.css
                          js/css byte-identical; index matched after normalisation
boot                      1 attempt, 2312 ms, the count surfaced live
environment line          SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE, whole
isPhysicallyObserved()    0 of 37 events, all attributed {emulator: 37}
origin.engine             QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)
                          — the bundled binary's own --version
board                     distro-v1-esp32, the legacy V1 board, not the S2 Mini
OLED                      observed, getBuffer()/display.display() qualifier intact
wave                      the eight Object3D quaternions moved; nothing was
                          commanded before the click
on the simulator          panel-desktop-simulator PRESENT, host-model attributed
negative controls         7/7 fired
a11y, shell / signal      73 / 452 text runs — 0 defects on both
survivors after close     qemu 0, desktop 0
```

**A real `runWavePose` executed on emulated Xtensa and moved the robot, in an
application installed from a `-setup.exe` into a directory that did not exist.**

### Uninstall

`uninstall.exe /S`, then: **0 files left** in the install directory, no `HKCU`
uninstall entry, **both** Start Menu entries gone.

**One thing is left, and it is stated rather than asserted away.** About 15 MB of
WebView2 cache under `%LOCALAPPDATA%\com.sesamelab.desktop` survives a silent
uninstall, because the generated `installer.nsi` removes it only inside
`${If} $DeleteAppDataCheckboxState = 1` — the uninstaller's *"delete application
data"* checkbox, which `/S` does not tick. That is the same behaviour a browser
has, Sesame Lab writes nothing into it, and ticking the box (or deleting the
folder) removes it. `just tauri-install` reports it as a **note**, in its own
section, separate from the placeholders.

The first version of the check asserted it *gone*, which is §8.4's second
lesson.

## 8. What was proved by making it fail

The standing warning is seven assertions in this project that turned out unable
to fail. Nothing below is trusted on a green reading.

### 8.1 Against the real, previous artefact — the two new phase-14 checks

Before rebuilding anything, phase 14 was run against the **executable T5 had
shipped**, which does not have the fix:

```text
FAIL  the packaged artefact — 2 problem(s):
  - phase 14: the JavaScript the packaged executable serves contains the
    panel-desktop-simulator testid in 1 bundle(s) and its sentence in 0.
  - phase 14 (packaged app on the simulator): the packaged app renders NO line
    naming what is driving it while its own behavioural simulator drives the
    scene. That is the one state this line exists for.
```

Both new assertions refused a real binary that a green run would otherwise have
been reported against. That is the strongest form of this control available and
it cost nothing but running the check before the fix.

### 8.2 Five bad fixtures for the new verdict, every run

`desktopSimulatorLineProblems` joins `selfTestVerdicts()`, which runs before the
app is launched. It must accept a good reading and refuse: the line **absent**
(T5's gap), present but **not laid out**, **T1's untrue sentence restored**,
**hardware no longer denied**, and the **trust card unmounted** underneath it.
5/5 refused; the good fixture passed.

### 8.3 Four negative controls on the installed application

Each mutates a real install and requires `just tauri-install --check` to refuse:

| Control | What fired |
|---|---|
| a licence file deleted from the install | *"the installer did not place licenses/QEMU-GPL-2.0.txt"* |
| the GPL text edited to a plausible paraphrase | **two** independent failures — the byte comparison, and the phrase check (*"present and is not the document it is named after"*) |
| the repository's copy of the offer edited without rebuilding | *"not byte-identical … (4510 B vs 4584 B)"* — the stale-installer case |
| an icon whose eyes and mouth are the background colour | *"the 16×16 entry of icon.ico has 0 pixels of the face colour"* |
| the Start Menu licences entry deleted | *"the installer created no Start Menu entry for the licences"* |

The icon control was produced by regenerating the source with `FACE` set to the
body colour and running `tauri icon` over it, so it is a real icon file and not
a doctored buffer.

### 8.4 Four checks that failed for the wrong reason, and what that found

The first version of the uninstall check polled only the **install directory**
and then asserted the registry key, the two shortcuts and the WebView2 profile.
NSIS copies itself to `%TEMP%` and re-launches, so all four were still being
deleted when the assertions ran: a perfectly clean uninstall was reported as
four survivors — beside a log line that cheerfully said the opposite, because
that sentence was typed rather than derived.

It is now one predicate over all three real ones, waited on and then asserted,
and the log line is computed from the same object. The bug is worth the
paragraph: an assertion that fires on a correct system is the same defect as one
that cannot fire, wearing the other hat.

**And the fourth was not a race — the assertion was simply wrong.** Once the
timing was fixed, the WebView2 profile still survived, and reading the generated
`installer.nsi` said why: a `/S` uninstall never ticks the "delete application
data" box, so that folder is *meant* to stay. Requiring its removal would have
failed every correct uninstall from then on. It is a note now (§7). The check
was caught by running it twice; the first run passed only because the folder
happened to have been deleted by hand an hour earlier.

### 8.5 The HTML normaliser, shown four documents every run

§5. One pair it must accept (hand-written, not derived from its own rules) and
four things it must refuse.

## 9. What did not change

* **`just dev`, `just dev-sim`, `just run`, `scripts/dev-lab.mjs`,
  `apps/web/server/lab-host.mjs`, `vite.config.ts`:** untouched. The web path
  still uses the HTTP lab host.
* **`hardware/`, `packages/`, `emulator/`, `firmware/`, `reference/`,
  `README.md`, `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`:** not touched.
  The last three are *bundled* by the installer, read-only, from where they are.
* **`apps/web/`:** two hunks, both the panel wording and its condition —
  `ui/Controls.tsx` (the sentence and its doc comment) and `App.tsx` (the
  condition). No test attribute, no new component, no new prop.
* **`src-tauri/src/*.rs`:** not one line. T3's job object, T4's stdio
  supervisor, T2's `resources.rs` and the three CLI flags are unchanged; the
  manifest grew because `build.rs` derives it from `bundle.resources`.
* **T5's phase 14, `just tauri-honesty`, the `tauri.localhost` guard and exit
  code 2:** all present and passing, with two assertions added and one
  (index.html byte-identity) narrowed to index.html alone with a proven
  substitute — §5.
* **Zero new dependencies.** The icon generator uses `node:zlib`; the install
  check uses `node:child_process`, `node:crypto` and `node:zlib`; nothing was
  added to any `package.json` or to `Cargo.toml`.
* `justfile` gained one recipe, `tauri-install`, and comments on `tauri-build`.

**The numbers, after everything above:**

```text
pnpm -r test        1,096 passing + 1 skipped   96+280+129+71+95+48+377, unchanged
pnpm -r typecheck   clean
11 data validators  clean
pnpm capture:web    44 captures, 0 problems     41 headless + 3 in the packaged window
cargo test          33 passing                  unchanged; no Rust source was edited
cargo clippy --all-targets -- -D warnings   clean
cargo fmt --check   clean
just tauri-install  exit 0                      install -> check -> uninstall
just tauri-honesty "<installed exe>"   exit 0
```

## 10. Awkward things, named

* **The two blanks in the source offer are unfilled, and the installer therefore
  must not be given to anyone yet.** §3.3. Everything else about it is done;
  this is a decision, not a task.
* **No "Open-source licences" item inside the app window.** §3.1. Three routes
  carry the obligation; the fourth and best one is a change in
  `apps/web/src/desktop/DesktopResources.tsx`, which T6 does not own.
* **The MSI is no longer built.** Anyone who wants it says `--bundles msi`. T2's
  31.0 MB measurement is still the right number for it.
* **The installed executable is `sesame-lab-desktop.exe`, not `Sesame Lab.exe`.**
  §2. Four tools name it. What the reader sees is right; what `dir` shows is a
  crate name.
* **SmartScreen was reasoned about, not triggered.** The signature status is
  measured (`NotSigned`, all three binaries) and the dialog's wording and the
  path through it are documented from what Windows shows for an unsigned
  Mark-of-the-Web binary — but no download was staged to make it appear, because
  the dialog is modal and would have hung an automated run. It is the one claim
  in this document that rests on knowledge rather than a transcript.
* **WebView2 talks to Microsoft sometimes.** §6.2. Observed once in two samples,
  from a WebView2 child process, not from ours. Said out loud in the shipped
  README rather than smoothed over.
* **`installMode: "currentUser"` is also the Tauri default.** It is written
  explicitly anyway, because the whole argument for NSIS over MSI rests on it
  and a default that changes upstream would change the deliverable silently.
* **The uninstaller is asynchronous and the check waits up to 60 s for it.** On
  a slow machine a genuinely stuck uninstall and a slow one look the same for
  the first minute.
* **A clean clone still cannot build this.** `tools/` and
  `emulator/qemu/images/` are gitignored; `just tauri-build`'s comment now names
  `node emulator/qemu/fetch-qemu.mjs` and `just qemu-image` out loud, which T2
  §8 and T3 §10 both asked for and neither could do from where they were.
