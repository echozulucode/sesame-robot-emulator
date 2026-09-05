---
task: "T7 — verify both targets together, and close the cold-clone cliff"
phase: 5
status: complete
date: 2026-09-05
owns: justfile, scripts, README (the quick start), docs/findings
plan: docs/plans/phase-5-tauri-desktop-app.md §5 T7, §9
follows: docs/findings/T5-packaged-honesty.md §10, docs/findings/T6-installer-and-first-run.md
---

# T7 — the two targets, run together, and the five commands nobody could see

Phase 5's closing workstream, and two claims:

1. **`just verify-all`** runs the web target and the packaged target in one pass
   and reports which of them actually ran. A skip exits **3**, never 0.
2. **`just setup`** takes a fresh clone to `just dev` in one command, is safe to
   re-run, and says what it did versus what was already there.

Both found something. §3 is the disagreement between the two targets that a
combined run turned up in its first minute; §6 is the three defects that fell
out of running `just setup` on a genuine `git clone`, none of which were in the
script.

`docs/findings/` is gitignored but tracked files inside it still commit. This
file needs `git add -f`.

---

## 1. `just verify-all` — what it runs

Nothing is reimplemented. Every target is an existing entry point run as a child
process, and its **exit code is the reading**.

```text
just verify-all
│
├─ web        node scripts/capture-web-screenshots.mjs --skip-packaged
│             41 captures, headless Chromium, real QEMU behind two phases
│
├─ packaged   sesame-lab-desktop.exe --resource-report      (T2)
│             sesame-lab-desktop.exe --emulator-selftest     (T3)
│             node scripts/verify-packaged-honesty.mjs       (T5 phase 14)
│
└─ installer  node scripts/verify-install.mjs                (T6)
```

The one composition decision is `--skip-packaged` on the harness. T5 §10
measured that **two packaged WebView2 windows cannot be driven at once** — the
second opens no debug port — so phase 14 runs exactly once, in the packaged
target, instead of twice in one command. The capture arithmetic is unchanged:
41 from the harness plus 3 from the packaged window is the same **44** that
`just capture` produces alone, and `just capture` itself is untouched.

Targets run strictly sequentially. That is a requirement, not a simplification.

## 2. Exit codes — the fourth case

T5 introduced a third code because *"nothing was verified" must not be
reportable as "everything passed" by a CI file that only looks at zero.*
Combining targets creates a fourth case — **some** were verified — which needs
its own code for exactly the same reason.

| | |
|---:|---|
| **0** | every requested target RAN and PASSED |
| **1** | a target ran and failed |
| **2** | nothing ran at all — T5's code, kept, meaning kept |
| **3** | INCOMPLETE: what ran passed, and at least one target did not run |

Exit 3 is the code this command produces most often on a machine that has not
run `just tauri-build`, and that is the point. `--only` also exits 3 when it
passes: a deliberately narrowed run is still a run that did not verify
everything, and the exit code should not depend on the operator's intent.

A missing artefact is never a quiet absence. It is printed in the plan before
anything starts, printed again where the target would have run, and printed a
third time in the verdict:

```text
════ packaged target: SKIPPED — src-tauri/target/release/sesame-lab-desktop.exe
     does not exist — run `just tauri-build`.
     NOTHING about the packaged app was verified by this run.
```

## 3. What the two targets turned out to disagree about

The first thing running them together surfaced was not a regression in either
one. It was that **the flash image `just qemu-image` builds is not the flash
image `just tauri-build` bundles**, and nothing in the repository said so.

| image | built by | consumed by |
|---|---|---|
| `distro-v1-esp32-cli` | `just qemu-image` | `just dev`, `QemuSesameRobot`, harness phase 6 |
| `distro-v1-esp32-nowifi` | nothing named it | harness **phase 5** |
| `distro-v1-esp32-cli-oled` | `pnpm build:qemu-image` | **`tauri.conf.json`'s `bundle.resources`** |

`just doctor` checked for one of the three. The justfile's own `tauri-build`
comment told a clean clone to run `node emulator/qemu/fetch-qemu.mjs` and
`just qemu-image` — which produces `cli` and leaves `cli-oled` absent, so the
build fails on a missing resource with nothing anywhere saying why. The README
repeated the same two lines.

All three images are now rows in `just doctor`, each naming its consumer, and
`just setup --all-images` builds all three. The justfile comment is corrected in
place and says what it used to say and why that was wrong.

This is the divergence T7 was written to expect. It is worth noting that it was
not a *drift* — it was never right — and that a year of green runs on both sides
would not have found it, because neither side ever asked about the other.

### And then a second one, inside three hours

While this workstream was being written, the repository's
`licenses/QEMU-SOURCE-OFFER.txt` was edited and committed — commit `d560655`,
filling in the GPL source offer's two deliberate placeholders. The next full
`just verify-all` failed:

```text
FAIL  the installed application — 1 problem(s):
  - licenses/QEMU-SOURCE-OFFER.txt in the install is not byte-identical to
    licenses/QEMU-SOURCE-OFFER.txt in the repository (4584 B vs 4979 B).
    The installed copy is the one a recipient reads, so it is the one that has
    to be right.
```

    PASSED   web target         731s   41 captures
    PASSED   packaged target     28s   3/3 sub-checks passed
    FAILED   installer target     9s   see the problems listed above
    exit 1

**The web target was green and the tree was wrong.** The built installer still
carried the placeholder text, because it had been built before the commit. That
is T6's licence-manifest check doing its job, and it is also the entire premise
of this workstream demonstrated by accident, on a real edit, within one
afternoon: the artefact drifted from the source, and nothing that ran only one
target could have said so.

`pnpm exec tauri build` was re-run and the installer target passes again — with
one visible consequence worth recording, because T6 named it as an invariant:
**the placeholder warning no longer prints.** T6's check is
`if (placeholders > 0)`, and there are now zero. The check is intact; the
condition is false because the user filled them in, which is what it was asking
for.

## 4. Runtime, measured

Measured on this machine (Windows 11, warm caches). The final green run, whose
report is committed as `docs/findings/assets/t7-verify-all.json`:

```text
target      seconds   what it did
web             731   41 captures, headless Chromium, 12 phases
packaged         28   resources 0 s + emulator self-test 6 s + phase 14 22 s
installer         8   install, resource report, QEMU boot, uninstall
                ───
total           767   12m 47s      3 target(s) verified, 0 failed, exit 0
```

Four full runs were made across this workstream and they agree to within 1%:
733 / 29 / 8, 731 / 28 / 9, 705 / 24 / 4 (the deleted `--fast`), 731 / 28 / 8.

**The web target is 95% of the command.** That number decided the shape of
everything else here, including what is NOT here.

### There is no `--fast`, and that is a measurement

One was written. It kept all three targets and shortened two of them — the
harness on `--skip-qemu`, the installer check on `--no-emulator` — and it was
run against the full one on the same tree:

```text
full    web 733 s + packaged 29 s + installer 8 s = 12m 50s
"fast"  web 705 s + packaged 24 s + installer 4 s = 12m 13s
```

**A 5% saving.** The harness's cost is a headless browser driving twelve phases,
not the two QEMU boots inside it, and there is nothing else in there to
subtract: every phase asserts something no other phase does. So `--fast` was
deleted rather than shipped. A flag with that name gets used *instead of* the
real thing, and here it would buy thirty-seven seconds for a materially weaker
run — the same trade as a skip reading as a pass, one level down.

The subset that is worth having is the one that drops a whole target and says
so:

```text
just verify-all --only packaged,installer     37 s     exit 3
```

That is the desktop half in under a minute, and it **cannot** report 0.

### It never writes into `docs/findings/assets`

`just capture` owns the committed capture evidence and produces 44. This
command runs the same harness with `--skip-packaged`, which produces 41 and
records `packagedHonesty: {ran: false}`. Letting that overwrite the recorded set
would leave a mixed directory and a report claiming the smaller number, with
nothing on disk saying which run wrote what — so the web target is pointed at
`node_modules/.cache/verify-all/web`. The packaged target's three captures still
go where `just tauri-honesty` has always put them.

The combined verdict is written to `docs/findings/assets/t7-verify-all.json`.

## 5. `just setup` — cold clone versus warm

Everything a clone needs beyond `git clone` is gitignored, which means it is
also **invisible**: `node_modules/`, every `dist/`, `tools/`,
`firmware/upstream/`, `emulator/qemu/images/`. The tree looks complete.

Measured, on a genuine `git clone` of this repository into a directory that had
never held it, with `tools/`, `firmware/upstream/`, `node_modules/` and every
`dist/` absent:

```text
    done       node_modules            4s   installed
    FAILED     workspace build         5s   pnpm exited 2 (the artefact is there anyway)   <- §6.1
    done       apps/web/dist           5s   built
    FAILED     qemu binary            35s   node exited 1                                   <- §6.2
    done       firmware/upstream      92s   present (pinned)
    done       arduino toolchain    1853s   tools/arduino-cli/
    done       qemu flash image      332s   distro-v1-esp32-cli (+0 other)

  5 fetched or built, 0 already present, 2 failed.

  NOT READY — 1 blocking prerequisite(s) are still absent:
    qemu binary          node emulator/qemu/fetch-qemu.mjs
exit 1
```

Two steps failed, and **both were real defects in this repository rather than in
the script** — §6. That is the whole argument for building this: the four
commands the README listed had never been executed in order on a clean tree by
anything that would notice.

The cost, measured on that clone after it finished:

```text
tools/arduino-data     14,327 MB      the Arduino/ESP32 toolchain — 31 minutes
firmware/upstream         220 MB      the pinned upstream tree
tools/qemu                173 MB      Espressif's QEMU fork
node_modules              124 MB
emulator/qemu/images        4 MB      the thing the 14 GB exists to compile
                       ─────────
total                  15,092 MB      about 37 minutes
```

**14 GB of compiler for a 4 MB image.** `installing esp32:esp32@3.3.11` installs
every Xtensa and RISC-V toolchain and every per-target library set. A command
that quietly starts that is not a good command, so the plan prints the number
and the alternative before anything begins:

```text
  NOTE  this plan includes the Arduino/ESP32 toolchain: about 31 minutes and 14 GB under
        tools/, all of it to compile one 4 MB flash image. `just dev-sim` — the behavioural
        simulator — needs none of it, and neither does anything above the emulator rows.
```

The second run on the same clone, after the two defects were worked around:

```text
    refreshed  node_modules            1s   installed
    already    workspace build              dist/ present
    already    apps/web/dist                built
    done       qemu binary            33s   tools/qemu/
    already    firmware/upstream            present (pinned)
    already    qemu flash image             distro-v1-esp32-cli (+0 other)

  1 fetched or built, 4 already present, 0 failed.
  Ready. Run `just dev` ...
exit 0
```

It did not re-download the 14 GB toolchain, did not recompile the image, and the
toolchain step was **dropped from the plan entirely** rather than skipped at run
time — the toolchain is a means, so when every image the run wants is on disk it
is not part of the run's cost at all. `just doctor` on that clone then exits 0
with two WARN rows, for the two images only the verification targets need.

Warm, in the repository this was written in:

```text
    refreshed  node_modules            1s   installed
    already    workspace build              dist/ present
    already    apps/web/dist                built
    already    qemu binary                  tools/qemu/
    already    firmware/upstream            present (pinned)
    already    qemu flash image             distro-v1-esp32-cli (+4 other)

  0 fetched or built, 5 already present, 0 failed.
exit 0
```

Under two seconds, and the one step that runs is `pnpm install` — deliberately,
because pnpm is the thing that knows whether the lockfile moved and a
`node_modules`-exists check does not. **That decision paid immediately.** The
first warm run modified `pnpm-lock.yaml`: `apps/web/package.json` lists
`@sesame-lab/sesame-qemu` under `dependencies` since commit `5c864fe`, and the
committed lockfile still recorded it under `devDependencies`. A skip-if-present
setup would have reported "already present" and left that drift in place
indefinitely.

`--dry-run` prints the plan and the cost and changes nothing, which is also how
the cold plan above was checked before it was run.

### `--sim`, which exists because of the 14 GB

`just setup --sim` stops before the emulator rows — dependencies, the pinned
upstream tree, the builds, and nothing else. About two minutes, no QEMU, no
14 GB toolchain, no flash image; everything `just dev-sim` needs and nothing it
does not.

It is a flag rather than a line of README advice because the advice would have
been `pnpm install && just build`, and `just build` exits 2 the first time on a
clean clone (§6.1). Telling a newcomer to run a command that fails once is
worse than having a flag.

A narrowed run is not allowed to imply a complete clone. `--sim` and `--only`
still take the final reading over **every** blocking prerequisite, and print the
ones they left absent — they just do not FAIL on them:

```text
  1 blocking prerequisite(s) are still absent — NOT part of this run:
    qemu binary          node emulator/qemu/fetch-qemu.mjs

  `just setup` (no --sim) fetches these; `just dev` needs them and `just dev-sim` does not.

  Ready for `just dev-sim` — the behavioural simulator, no emulator involved.
exit 0
```

Checked by moving `tools/qemu` aside and running it: the row is named, the
verdict is scoped, and the exit code is 0 because nothing this run was
responsible for is missing. The same reading with no flag exits 1.

## 6. Three things a real cold clone found, none of them in this script

### 6.0 The fifth command, written down nowhere

The README's cold-clone sequence was four commands. It is five, and the missing
one is not small:

```text
node emulator/qemu/build-qemu-images.mjs cli
  └─ ensureBaseScratch() → scripts/build-firmware.mjs → tools/arduino-cli/arduino-cli.exe
       if (!fs.existsSync(CLI)) { console.error('run scripts/setup-firmware-toolchain.ps1 first'); exit(2) }
```

`just qemu-image` is a **firmware compile**. It needs the portable Arduino/ESP32
toolchain — about a gigabyte, installed by `scripts/setup-firmware-toolchain.ps1`
— and the README named that script only in a later paragraph, as something you
need *"if you want to build the firmware yourself"*, which reads as optional and
is not.

So a reader following the quick start on a clean machine reached step three of
four and got `exit 2` from a script they had not been told about. `just setup`
installs it, and installs it **conditionally**: the toolchain is a means, not an
end, so the step is dropped from the plan entirely when every image the run was
asked for is already on disk. A clone that was handed its images does not
download a compiler, and the printed cost is the cost.

### 6.1 `just build` fails the first time on a clean clone

```text
packages/sesame-api build: src/cli.ts(172,59): error TS2307:
  Cannot find module '@sesame-lab/sesame-qemu' or its corresponding type declarations.
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  Exit status 2
```

`packages/sesame-api` and `packages/sesame-qemu` are a **cyclic workspace
dependency** — pnpm says so on `install`, in a `WARN` nobody had a reason to
read — and with neither holding a `dist/`, pnpm can schedule them together.
`sesame-api`'s `tsc` then has nothing to resolve against. Running it a second
time works, because by then `sesame-qemu/dist` exists.

So `just build` on a fresh clone exits 2, and the README told a fresh clone to
run `just build`. `just setup` retries that one step exactly once, with the
reason recorded next to the retry and the result reported as *"dist/ present (on
the second attempt)"* rather than silently. It is not a general retry loop:
that turns a real failure into a slower real failure.

Reproduced deliberately afterwards by deleting `packages/*/dist` and
`emulator/bridge/dist` on the cold clone and re-running the step — first attempt
exit 2, second attempt clean.

### 6.2 `node emulator/qemu/fetch-qemu.mjs` fails when GNU tar is on PATH

```text
[q1] sha256 OK 3c483d77f5350a568df1faf4d8dbc82c95d6bc2b826d0d4be910485e0a68ca2a
tar: Cannot connect to C: resolve failed
Error: Command failed: tar -xf C:\...\tools\qemu\dl\qemu-...tar.xz
```

The archive downloaded and its checksum verified against Espressif's own
manifest. Then `tar -xf C:\...` was handed to **GNU tar 1.34**, which reads
`C:` as a remote host and tries to connect to it. Windows' own
`C:\Windows\System32\tar.exe` (bsdtar) handles the path fine — but Git for
Windows puts `C:\Program Files\Git\usr\bin` ahead of System32 on this
machine's PATH, so `tar` resolves to GNU tar from **both** PowerShell and bash.
`--force-local` or an explicit `System32\tar.exe` would fix it.

That file is in `emulator/`, which this workstream must not touch, so it is
named rather than fixed. What matters for T7 is what happened next: the step
was reported `FAILED`, the run ended `NOT READY — 1 blocking prerequisite(s)`,
and it exited **1**. A setup script that trusted its own step list would have
finished green over a clone with no emulator in it.

## 7. One list, not two

The brief's instruction was to reuse `scripts/doctor.mjs`'s checks rather than
write a second set that can disagree. The checks were not reusable — they were
`add(...)` calls with the detection inline — so they were extracted to
`scripts/lib/prereqs.mjs`, and **both** commands now read that one array.

```text
scripts/lib/prereqs.mjs      id · name · level · detect() · fix · setup
        │
        ├── scripts/doctor.mjs   renders detect() as a row, prints fix
        └── scripts/setup.mjs    runs setup, then calls detect() AGAIN
```

`just doctor` closes by naming which of its failing rows `just setup` would have
handled, computed from `p.setup !== null` rather than typed — so a prerequisite
that gains or loses a setup command cannot leave that sentence stale.

Every `detect()` is a **file on disk**, never a flag or a stamp file. A stamp
says *"we ran the fetcher"*, which is a different claim from *"the thing is
here"*, and it is the wrong one.

## 8. The check that matters in `just setup`, and how it was made to fail

Every step is detected before it runs and **detected again afterwards**. The
post-condition is the artefact, not the exit code:

```text
already    the artefact was on disk; nothing ran
done       it was absent, the command ran, and it is there now
FAILED     the command exited non-zero, OR it exited zero and the artefact is
           still absent
```

That second failure mode is the whole reason the re-detection exists. A fetcher
that succeeds without producing anything — a partial extract, an HTTP error page
saved as an archive, a compile that wrote to the wrong directory — exits 0, and
a setup script that trusts exit codes hands the reader a green summary and a
broken clone.

**This project's standing warning is eight assertions that turned out unable to
fail**, most recently T6's uninstall poll racing NSIS into four false survivors.
So the re-detection was made to fail before it was believed.
`SESAME_SETUP_NOOP_STEP=<id>` replaces one step's command with a no-op that
exits 0 — the step then always "succeeds", and the only thing that can refuse it
is the re-detection. On the cold clone of §5:

```text
$ SESAME_SETUP_NOOP_STEP=node_modules node scripts/setup.mjs --only node_modules
──── node_modules — workspace dependencies
     absent (missing): pnpm install
     [SESAME_SETUP_NOOP_STEP] the command for "node_modules" was replaced with a no-op that exits 0.

    FAILED     node_modules   pnpm exited 0 but node_modules is still missing —
                              the command reported success and produced nothing

  NOT READY — 4 blocking prerequisite(s) are still absent:
exit 1
```

The final verdict is a **third** reading of the disk, taken through
`PREREQS[].detect()` rather than from a tally of what the script believes it
did — because `just setup` claiming success while `just doctor` still fails is
precisely the drift this workstream exists to close.

## 9. What was proved by making it fail

Nothing below is trusted on a green reading. Each was made to fail first, and
two of them failed on their own before anyone tried.

| Check | How it was made to fail | Result |
|---|---|---|
| **exit 2 — nothing verified** | `sesame-lab-desktop.exe` and `bundle/nsis/` moved aside; `--only packaged,installer` | both SKIPPED with named reasons, `NOTHING VERIFIED`, **exit 2** |
| **exit 1 — a target failed** | `src-tauri/target/release/images/` moved aside, so the packaged app lost its flash image | all three sub-checks fired — the resource report, the emulator self-test, and 19 phase-14 problems — `exit 1`, `qemu=0 desktop=0` survivors afterwards |
| **exit 3 — incomplete** | `--only packaged,installer` with both passing | `INCOMPLETE — 2 target(s) passed and 1 were not verified`, **exit 3** |
| **the web target propagates a real failure** | not injected — the harness's phase-12 flake fired on its own during the first full run | `FAILED web target 733s`, the problem quoted in the summary, `exit 1`. §11 |
| **the installer target propagates a real failure** | not injected — the licence text was committed mid-session and the installer went stale (§3) | `FAILED installer target 9s` beside a green web target, `exit 1` |
| **`just setup`'s post-condition** | `SESAME_SETUP_NOOP_STEP=node_modules` — the command replaced with a no-op that exits 0 | `FAILED  pnpm exited 0 but node_modules is still missing`, **exit 1** |
| **`just setup`'s final disk re-read** | not injected — the cold clone's QEMU fetch really failed (§6.2) | `NOT READY — 1 blocking prerequisite(s) are still absent`, exit 1, while five steps had succeeded |
| **the one named retry** | `packages/*/dist` and `emulator/bridge/dist` deleted on the cold clone, then `--only workspace-build` | first attempt exited 2, retry succeeded, reported as `dist/ present (on the second attempt)` |
| **`--sim`'s scoped verdict** | `tools/qemu` moved aside, then `--sim` | `1 blocking prerequisite(s) are still absent — NOT part of this run`, named, **exit 0**; the same tree with no flag exits 1 |

The two that fired without being asked are worth more than the five that were
staged. A verdict that has only ever refused a fixture is a verdict that has
only ever refused a fixture.

## 10. What did not change

* **`just dev`, `just dev-sim`, `just run`, `just capture`, `just tauri-*`:**
  none of their recipes changed. `just capture` was re-run whole after all of
  this and is **44 captures, 0 problems, exit 0** — 41 headless plus 3 from the
  packaged window, T5's phase 14 included.
* **No application source was touched.** Not `apps/web/`, not `packages/`, not
  `emulator/`, not `src-tauri/`, not `firmware/`, not `hardware/`, not
  `reference/`, not `LICENSE` or `NOTICE`. T7 is a justfile, three scripts, one
  extraction, and the README's quick start.
* **T5's phase 14 and the `tauri.localhost` guard:** untouched, and exercised —
  the packaged target ran it whole in every full run, including the origin-guard
  self-test (3 accepted, 8 refused) and 7/7 negative controls.
* **T6's installer check and its licence manifest:** untouched, and run as the
  third target — `22/22` resources, `0 problem(s)`. Its **placeholder warning**
  is also untouched and no longer prints, because commit `d560655` filled the
  two placeholders in during this session; the branch is `if (placeholders > 0)`
  and the count is now 0. See §3.
* **T3's teardown:** `survivors after close qemu=0 desktop=0` in every packaged
  run here, including the deliberately broken one.
* **Zero new dependencies.** `scripts/setup.mjs` and `scripts/verify-all.mjs`
  use `node:child_process`, `node:fs`, `node:path`, `node:process` and
  `node:url`, all of which `scripts/doctor.mjs` already used.
* **Tests: 1,096 passing + 1 skipped**, 11 validators, 33 Rust tests. Nothing
  under test imports any file T7 touched, and no validator reads `README.md` or
  the `justfile` (checked).

**One file changed that is not on that list: `pnpm-lock.yaml`.** Three lines,
moving `@sesame-lab/sesame-qemu` from the `devDependencies` block of the
`apps/web` importer to the `dependencies` block. `apps/web/package.json` has
listed it under `dependencies` since commit `5c864fe`; the lockfile had not been
regenerated since. `just setup`'s `pnpm install` reconciled it on the first warm
run. It is included rather than reverted because reverting it would only mean
the next person's `pnpm install` produces the same diff with no explanation
attached — and because it is the evidence that running `pnpm install`
unconditionally was the right call.

## 11. Awkward things, named

* **A pre-existing flake in the capture harness, seen once.** The first full
  `just verify-all` failed phase 12 with

  ```text
  at 1280x800 (medium) activating "modules" left activeModule="learn" and
  1 laid-out module pane(s) (["modules"]). One at a time is §11.3
  ```

  The pane had already switched and `shell().activeModule` had not, 320 ms after
  `setModule('modules')` — an inconsistent reading rather than a two-module
  state. `just capture` run immediately afterwards on the same tree was green,
  44/44. **T7 changed no `apps/web/` code and no harness code**, so this is
  reported, not owned: it is a race in the probe or in the 320 ms wait, it is
  rare (once in three runs of that phase), and it is now visible because
  something runs the whole harness in one command. Left for whoever owns W7's
  shell.
* **`node emulator/qemu/fetch-qemu.mjs` cannot run when GNU tar precedes
  Windows' `tar.exe` on PATH.** §6.2. It is one line in a file this workstream
  is not allowed to touch (`emulator/`), so it is named here rather than fixed,
  and `just setup` reports it correctly instead of hiding it.
* **The 14 GB is not optional and not this workstream's to fix.** There is no
  prebuilt flash image anywhere in this repository or its releases, so *"get a
  clone to `just dev`"* means *"compile ESP32 firmware"*, which means the
  toolchain. The honest options are to publish the 4 MB image, or to keep saying
  the number out loud. `just setup` does the second.
* **The cold clone was cold, the machine was not.** `tools/` and
  `node_modules/` were genuinely absent and everything under them was fetched
  fresh, but this is a machine that already has Node, pnpm, `just`, pwsh 7,
  Edge, a Rust toolchain and a warm HTTP cache. `just setup` installs none of
  those and does not claim to; the prerequisites row in the README still names
  them.
* **`--all-images` has not been run on a cold clone.** Two more ~5.5-minute
  Xtensa compiles. The plan prints them; the measurement is from the warm tree.
* **`just verify-all` opens a real desktop window for about half a minute.**
  Inherited from T5 §10: WebView2 has no headless mode. Two packaged windows
  still cannot be driven at once, which is why the targets are strictly
  sequential and why the harness gets `--skip-packaged`.
* **The packaged and installer targets are much cheaper than their own findings
  estimated** — 23 s against T5's "~90 s" for phase 14, and 8 s against T6's
  "~40 s" for the install check. Their recipe comments are left as they wrote
  them; this is a different machine on a different day, and quietly editing
  another workstream's measured claim is worse than noting the difference.
* **Exit 3 will annoy someone.** `just verify-all` on a tree with no
  `tauri build` artefact is a non-zero exit on a green harness. That is the
  design, and the message says so in full, but a shell script that treats any
  non-zero as a failure will stop there. That is the correct place for it to
  stop.
