---
task: "T5 — the honesty surfaces, asserted against the packaged artefact"
phase: 5
status: complete
date: 2026-09-05
owns: scripts, justfile (one recipe), docs/findings
plan: docs/plans/phase-5-tauri-desktop-app.md §5 T5, §9
follows: docs/findings/T4-tauri-robot.md §6, §7, §9
---

# T5 — every provenance surface, made able to fail in the packaged build

**Done when:** the surfaces T4 read out of the packaged window *by looking* fail
the build if they regress. They do — `phase 14` of
`scripts/capture-web-screenshots.mjs`, also runnable alone as
`just tauri-honesty`.

`docs/findings/` is gitignored but tracked files inside it still commit. This
file needs `git add -f`, and so do the three new captures and the report beside
them: `docs/findings/assets/t5-packaged-{idle,not-built,wave}.png` and
`docs/findings/assets/t5-packaged-honesty.json`.

---

## 1. What the phase is, and how it gets an artefact

```text
scripts/capture-web-screenshots.mjs   phases 1-13   headless Chromium, apps/web/dist over HTTP
                                      phase 14 ───► scripts/lib/packaged-honesty.mjs
                                                    │
                                                    ├─ src-tauri/target/release/sesame-lab-desktop.exe
                                                    │  launched with
                                                    │  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port
                                                    ├─ scripts/lib/cdp.mjs        the same CDP client
                                                    └─ scripts/lib/honesty-probes.mjs
                                                       the same scans phases 12 and 13 use
```

**It does not build anything.** An artefact is a prerequisite, and the phase has
three outcomes rather than two:

| | |
|---|---|
| no `sesame-lab-desktop.exe` | `ran: false`, with the reason and `just tauri-build`, printed as `SKIPPED` and pushed onto the run's notes. Never silent. |
| an artefact that is not a package | `ran: false` **and a recorded problem** — §3 |
| an artefact | every assertion below, and the run fails on any of them |

`scripts/verify-packaged-honesty.mjs` runs the same function alone and exits
**0 / 1 / 2** — the third code is "there was nothing to check", because a CI file
that only looks for zero must not read *nothing was verified* as *everything
passed*.

`--packaged-exe` points it at an **installed** copy instead of
`target/release`: `app.path()` resolves against the directory the executable is
in, so the installed copy checks the installed copy. That is T6's lever, wired
now rather than later.

### The artefact is checked for being the right artefact

Before any surface is read, the window is asked for `/index.html` and every
same-origin script and stylesheet it references — three files — and each is
compared byte-count-and-hash against `apps/web/dist` on disk. An executable
built before the change under test looks completely right, and grading it is the
same class of mistake as grading Vite, only quieter, because it once was
correct.

Proved three ways. One byte is flipped on a copy of `index.html` every run, so
the hash comparison has to say no to something. The count of assets found is
asserted (`>= 2`) — because **the first version of the ref filter matched
nothing**: it required a leading `/` and Vite writes `./assets/index-*.js`, so
it reported a clean `checked: 1` while never looking at a bundle. And once, for
real: a single newline was appended to `apps/web/dist/assets/index-*.css` and
the run failed with

```text
assets/index-DmCj8ILI.css: the packaged window serves 74165 B (fnv 1468695768)
and apps/web/dist holds 74166 B (fnv 2702120598).
```

then the file was restored and compared byte-for-byte against its backup.

## 2. The surfaces, and how each is asserted

All read from `http://tauri.localhost/` in a WebView2 window inside the shipped
executable, driving the QEMU that was bundled with it.

| Surface | Asserted as | Reading |
|---|---|---|
| the environment line | exact string, laid out, **and not truncated** (`text-overflow`, `line-clamp`, `scrollWidth > clientWidth`) | `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE` |
| `isPhysicallyObserved()` | **the count**: `physicallyObservedEvents === 0` AND `totalEvents ≥ 20` AND every counted event attributed to an origin | `0 of 37`, `{emulator: 37}` |
| the origin, measured half | `origin.engine` **equals what the BUNDLED `qemu-system-xtensa.exe` answers to `--version`**, and is **not** the frontend's compile-time constant | measured `QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)`; the derived constant is `qemu-system-xtensa/9.2.2-esp_develop_9.2.2_20260417` — a different string, so the app cannot have supplied it |
| the origin, derived half | the record `originForImage()` keys off the image path is present and non-empty: `kind`, `board`, `elided`, `firmwareDeviations` | 9 elided subsystems, deviations listed |
| the scene | the eight `THREE.Object3D.quaternion`s **moved** across the wave, and nothing was commanded before the click | worst component delta 0.707 from an idle start |
| the board | `distro-v1-esp32` **and** "legacy V1 board" **and** "not the S2 Mini", in the rendered text | `distro-v1-esp32 — the legacy V1 board. Not the S2 Mini in this project's pin diagram.` |
| the OLED | `observed` only when `oledFramebuffer` is true and `ssd1306-panel` is not elided; the explanation must still carry `getBuffer()`, `display.display()` and "not a measurement" | `observed`, `fromEmulator: true`, qualifier intact |
| `pwm.output` | `inferred` / `INFERRED FOR EXPLANATION`, and no row anywhere claims physical observation | still inferred under real firmware |
| `CONCEPTUAL` / `NOT BUILT` | counted where they render, laid out — the Learn list's conceptual badges, and lesson 8's unbuilt serial-console controls | present |
| `panel-desktop-simulator` | **absent** while the emulator drives and while the packaged app's own simulator drives, **and its branch still present in the JavaScript the executable serves** — §6 | absent in the DOM, present in the bundle |
| W1 typography | the **same** `TYPE_SCAN_JS` phase 12 uses, 14 px floor | 0 below floor |
| W6 contrast / targets / focus / overflow / pointer-only / provenance colour | the **same** `CONTRAST_JS`, `TARGETS_JS`, `FOCUS_STATE_JS`, `OVERFLOW_JS`, `POINTER_ONLY_JS`, `PROVENANCE_JS` phase 13 uses | 0 defects |
| T3's teardown | `tasklist` — **not** the harness's own bookkeeping — before and after | 0 survivors |

The a11y scans run **twice**: the bare shell, and with the `signal` module open.
The shell alone is 73 runs of text, 18 controls and 6 provenance badges; the
Signal ladder is 452, 25 and 42. A scan that only ever saw the shell would have
been clearing the smallest surface the app has.

## 3. The trap, and the proof that the guard catches it

T4 §9: *"a plain `cargo build --release` is not a packaged build. Without
`tauri build`'s feature set it serves `devUrl`, so it will silently use whatever
is on `:5173`."*

So `packagedOriginProblem(url)` runs on the CDP target before anything else and
**gates the whole phase** — a failed guard stops the run and records
`ran: false` rather than producing a green report about the wrong document. It
is exact rather than substring: the hostname must be `tauri.localhost` whole,
with no port, so `http://tauri.localhost:5173/` and
`http://tauri.localhost.example.com/` are both refused.

**A guard that has never refused anything is not known to be a guard**, so it is
proved two ways.

*Every run*, against a table of eleven URLs — 3 accepted, 8 refused, including
`http://127.0.0.1:5173/` and `http://localhost:5173/`.

*And once, for real.* A Vite dev server was started on `:5173`, and the phase was
pointed at `src-tauri/target/debug/sesame-lab-desktop.exe` — a plain `cargo
build`, with no `custom-protocol` feature:

```text
[web] phase 14 CDP target: http://127.0.0.1:5173/
NOTE  phase 14: something is listening on :5173 while the packaged window was checked.
FAIL  the packaged artefact — 1 problem(s):
  - phase 14: the CDP target is "http://127.0.0.1:5173/", not http://tauri.localhost/.
    That is a DEV SERVER, so this run would be verifying Vite rather than the package.
    A plain `cargo build --release` has no `custom-protocol` feature and falls back to
    `devUrl` — build with `pnpm exec tauri build` (`just tauri-build`).
```

`exit=1`, `ran: false`, `survivorsAfterClose: {qemu: 0, desktop: 0}`. **Not one
honesty surface was read**, which is the behaviour being claimed: the phase
cannot be made to pass by pointing it at Vite. The Vite server was killed and
`:5173` confirmed free afterwards.

The phase also reports whether anything is listening on `:5173` at all, so the
guard's message is never the first the reader hears of a dev server.

## 4. What was proved by making it fail

The standing warning in this project is six assertions that could not fail:
`querySelector !== null` passing for a hidden button; L4's *"it scrolled there"*
going vacuous; W7's `clientHeight - scrollHeight` bounded the wrong way and
repeated by W8; `data-oled-zoom` claiming 2 while rendering 1.77×; and W6's
contrast maths reporting 4.21 for a run that was 1.66.

Their common shape is that the arithmetic was never shown a case it should
refuse. So nothing here is trusted on a green reading alone.

### 4.1 Seven checks broken in the real packaged window — 7/7 fired

Each mutates the window, requires the detector to report the defect, and undoes
it; the surfaces are re-read afterwards so a control that failed to clean up
cannot be mistaken for a regression in the app.

| Control | The detector that had to notice |
|---|---|
| the environment line clipped to 24 px | `TRUNCATED` from `environmentLineProblems` |
| a clone claiming `SYSTEM: SESAME ROBOT · PHYSICAL HARDWARE: 12 OBSERVED EVENTS` | the exact-text comparison |
| a `[data-testid="panel-desktop-simulator"]` node injected | the presence probe — this is what stops "absent" passing for a renamed testid |
| a `.prov` badge painted its own background colour | `CONTRAST_JS` failures |
| a command button forced to 8×8 | `TARGETS_JS` `underWcag` / `unhittable` |
| the environment line at `font-size: 9px` | `TYPE_SCAN_JS` `below` |
| a focused control with `outline: none; box-shadow: none` | `FOCUS_STATE_JS` `hasRing === false` |

### 4.2 Three more, proved outside the run

| Check | How it was made to fail |
|---|---|
| the `tauri.localhost` guard | a real Vite on `:5173` and a real `cargo build` binary — §3 |
| the served-asset comparison | one newline appended to the packaged CSS — §1 |
| the asset **count** | it was already failing silently, and said so once asserted — §1 |
| the CDP attach itself | two packaged windows at once; the second exposed no debug port and the run failed with a recorded problem, exit 1, and 0 survivors — §10 |

### 4.3 The survivor check, proved in both directions

`tasklist` is asked **while the packaged window is driving real firmware** and
required to see ≥ 1 `qemu-system-xtensa.exe`, and again after the window is
closed and required to see 0. A count taken only after the close cannot tell
*the teardown worked* from *nothing ever started*.

### 4.4 The verdicts, shown the regression each exists to catch

Every judgement is a pure function over a reading, and `selfTestVerdicts()` runs
each against a good fixture and bad ones **before the app is launched**.
Twenty-two bad fixtures, each the shape the surface would take if packaging
dropped it:

* the environment line missing, ellipsised, not laid out, or reading
  `PHYSICAL HARDWARE: 3 OBSERVED EVENTS`;
* one event slipping through `isPhysicallyObserved()`; zero events counted at
  all; events counted but not attributed; a `physical-robot` boundary;
* the engine equal to the frontend's own constant; the board renamed to
  `s2mini`; `unsupportedBoards` emptied; the origin kind upgraded to hardware;
  the elided list emptied; the firmware deviations dropped;
* the board named without "legacy V1" or without "not the S2 Mini";
* OLED `observed` with `oledFramebuffer: false`; the `getBuffer()` qualifier
  dropped; the `display.display()` qualifier dropped; both SSD1306 names elided
  at once;
* `pwm.output` promoted to `OBSERVED FROM EMULATOR`; a row claiming
  `ON HARDWARE`.

**This caught a real defect in itself on the first run.** `OriginKind` has no
`hardware` member — it is `physical-robot` — so the "a hardware boundary"
fixture was accepted by a check reading `counts.hardware`. That check would have
been permanently green against a key that can never exist, which is failure mode
number seven written out in advance. The table refused to pass until both were
the same word.

## 5. The failure the negative controls found, which looked exactly like a product bug

The first version of the *"environment line claiming hardware"* control set
`innerHTML` and put the original markup back afterwards. The text was right
again and the element was **dead**: React holds references to the text nodes it
created, and destroying them leaves a subtree that never updates.

Every assertion after it still passed. Then the packaged app was switched to its
own simulator and the environment line went on reading `SYSTEM: QEMU EMULATOR`,
which is precisely the failure this workstream exists to catch — reported
against an app that was rendering it correctly. It took a second window, driven
without the controls, to see the line update normally.

The control now clones the element, mutates the clone, and inserts it *before*
the original so `querySelector` finds it first. Every other control touches only
the `style` attribute, which React does not manage on these elements.

The lesson is worth the space: **a negative control that corrupts the thing it
is testing produces a false positive that is indistinguishable from the real
defect.** The tell was that the failure appeared only in the full sequence.

## 6. `panel-desktop-simulator` — one direction asserted, one that no longer exists

The plan asks for the line to be **absent when the emulator is driving and
present when the simulator is**. Only the first half is reachable in this
artefact, and the reason is a consequence of T4 rather than an oversight:

```tsx
desktopSimulator={backendId === 'sim' && labProbe?.labHost === 'desktop'}
```

`labProbe` is only ever set to `desktopSimulatorProbe()` when
`desktop.selectsSimulator`, which is `present && TAURI_EMULATOR_BACKEND ===
null`. T4 set that constant to `'qemu'`, so in a packaged build `labProbe` stays
`null` and **no reachable state renders the line** — including the state where
the reader has switched the packaged app to the behavioural simulator.

What is asserted instead:

1. **absent** while the emulator drives, with the presence probe proved live by
   injecting a node with the same testid (§4.1) — so "absent" cannot pass for
   "the testid was renamed";
2. **the branch is still in the JavaScript the executable serves.** The bundle
   is fetched from `tauri.localhost` and searched for both
   `panel-desktop-simulator` and *"This desktop build has no emulator yet"*.
   Without this, "absent" would go on passing after the component was deleted —
   and unlike every other surface here, no state of this artefact would notice;
3. **absent** while the packaged app's own simulator drives, *and the claim it
   used to carry asserted on the surfaces that do exist there*: the environment
   line must read `SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE`, every event
   must be attributed to `host-model`, and `isPhysicallyObserved()` must still be
   0. A reader on the simulator inside the packaged app is still told it is a
   host model and not the emulator.

The run records this as a **note**, not a pass. Fixing it is a product change
(the line's wording says *"this desktop build has no emulator yet"*, which is no
longer true) and belongs to T6, not to a workstream about assertions.

And stated plainly, because it is the one gap in this workstream: **nothing
anywhere renders that line and looks at it.** `desktop-simulator.test.ts` covers
the two functions behind its condition — `detectDesktopShell` and
`desktopSimulatorProbe` — and not the JSX; there is no DOM test of `TrustCard`
with `desktopSimulator: true`. So the branch is known to be shipped (it is in the
bundle, and the negative control proves the probe would find it) and is not known
to be rendered correctly. Adding a jsdom render of that one card would close it,
and is a test rather than an assertion about the package, which is why it is
named here instead of written.

## 7. The probes are now one object, not three copies

Phase 13 carried its own restated copy of phase 12's correctness-selector list,
under a comment calling the duplication *"the smaller evil"* because there was
no scope in which both could see one array. The packaged phase would have been
the third copy — of the selector list, of the 14 px floor, and of the contrast
arithmetic that has already been wrong once.

`scripts/lib/honesty-probes.mjs` (869 lines) is that scope. The move was
verified as a move: a script compared each extracted probe against
`git show HEAD:scripts/capture-web-screenshots.mjs`, ignoring indentation, and
all nine came back identical. `TEXT_FLOOR_PX` now has one definition, and
`W6_CORRECTNESS_SELECTORS` is an alias of `CORRECTNESS_SURFACE_SELECTORS` rather
than a second array.

`scripts/lib/cdp.mjs` is the same story for the protocol client. It was inside
`launchBrowser()` because that file was the only thing that spoke CDP; the
packaged window is the second, and it is not a browser the harness spawned.
`launchBrowser()` now calls it and is 60 lines shorter.

## 8. The numbers

```text
CDP target                    http://tauri.localhost/          guard passed
origin-guard self-test        3 origins accepted, 8 refused
verdict self-test             every verdict refused its bad fixture
served assets                 index.html + index-BSgqlBYh.js + index-DmCj8ILI.css,
                              all byte-identical to apps/web/dist
bundled resources             13/13 present, 79,098,855 B
boot                          1-3 attempts, 2.2-6.5 s, the count surfaced live
environment line              SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE, whole
isPhysicallyObserved()        0 of 37-39 events   counts {emulator: all of them}
origin.engine                 QEMU emulator version 9.2.2 (esp_develop_9.2.2_20260417)
                              — the bundled binary's own --version, not the constant
OLED                          observed, fromEmulator, 571 lit pixels,
                              getBuffer()/display.display() qualifier rendered
negative controls             7/7 fired
a11y, shell / signal module   73 / 452 text runs, 18 / 25 targets, 6 / 42 badges,
                              39 / 40 focusables tabbed — 0 defects on both
survivors after close         qemu 0, desktop 0
```

The whole harness, with phase 14 in it: **44 captures, 0 problems** — the 41 that
existed plus three from the packaged window. `pnpm test`: **1,096 passing +
1 skipped**, unchanged.

## 9. What did not change

* **`just dev`, `just dev-sim`, `just run`, `scripts/dev-lab.mjs`,
  `apps/web/server/lab-host.mjs`:** untouched. **No `apps/web/` source was
  modified at all** — not even a test attribute; every packaged assertion is
  made through hooks and DOM the app already publishes.
* **`hardware/`, `packages/`, `emulator/`, `firmware/`, `reference/`,
  `src-tauri/`:** not touched. T5 needed no Rust hook.
* **Tests: 1,096 passing + 1 skipped**, unchanged — 96 + 280 + 129 + 71 + 95 +
  48 + 377. T4's contract suite is still 15/15 and `--supervisor-stdio` is
  untouched.
* **Zero new dependencies**, frontend or otherwise. The phase uses `node:net`,
  `node:child_process` and the global `WebSocket`, all of which the harness
  already used.
* `justfile` gained one recipe, `tauri-honesty`.

## 10. Awkward things, named

* **The packaged phase opens a real window.** WebView2 has no headless mode, so
  `just capture` now pops a desktop window for about ninety seconds. Phases 1-13
  stay headless.
* **Two packaged windows cannot be driven at once.** Running the harness and
  `just tauri-honesty` concurrently was tried by accident: WebView2 shares one
  browser process per user-data folder, the second instance opened no debug port
  of its own, and the run failed with *"the packaged window never exposed a CDP
  page target"*. It failed **correctly** — a recorded problem, exit 1, and
  `tasklist` showing 0 survivors afterwards — which is the one thing that
  mattered, but the two do not overlap and there is nothing here that stops
  someone trying.
* **It adds three captures** — `t5-packaged-idle.png`,
  `t5-packaged-not-built.png`, `t5-packaged-wave.png` — when it runs, and none
  when it skips. The 41 that existed are unchanged.
* **The window is measured at its own size, not at six.** `tauri.conf.json` opens
  1200×760 and that is what a reader gets; the six-window responsive sweep stays
  phase 12's job against the dev build. A packaged window resized by hand is not
  covered.
* **`crypto.subtle` is not used for the asset comparison.** It needs a secure
  context and `http://tauri.localhost` is only *probably* one; FNV-1a over the
  bytes is enough to answer "is this the dist on disk" and cannot silently stop
  running.
* **The contract suite and this phase both boot QEMU**, so a full `pnpm test`
  plus `pnpm capture:web` now boots the emulator around twenty times. Both are
  gated on an artefact existing, so a clone with no cargo pays neither.
* **What could only be verified by eye.** Three things, all from looking at
  `t5-packaged-idle.png`:
  1. that the window *looks* like the app — the robot renders, the OLED face is
     drawn, the panels are laid out. Nothing compares pixels to a reference.
     Phase 6's `canvasPixels` check would catch a blank canvas and was **not**
     ported, because a WebView2 window on a real GPU is not the SwiftShader
     surface that threshold was calibrated against; what phase 14 asserts
     instead is that the eight `Object3D.quaternion`s moved when wave was
     pressed, which a blank canvas would still pass.
  2. that the packaged app opens with the **Signal** module already active. That
     is W8's default and it is correct, but it is not asserted anywhere here —
     the scans set the module explicitly.
  3. that at 1200 px several status-strip segments are ellipsised — `con…`,
     `0 physical…`, `q…`, `distro-…`. **The environment line is not**, which is
     the rule W3 wrote and this phase enforces, and each clipped segment repeats
     a claim that is rendered whole somewhere else (`PHYSICAL HARDWARE: NONE` on
     the strip and on the trust card; the board on the trust card). It is
     nonetheless a surface a reader meets, none of it is in
     `CORRECTNESS_SURFACE_SELECTORS`, and so nothing fails if it gets worse.
     Naming it rather than quietly widening the list, which would change what
     phases 12 and 13 assert as a side effect of a T5 decision.
* **`csp: null` is still `csp: null`.** T4 §9 flagged it; T5 asserts what the
  window says rather than what it is allowed to load, and the setting is still
  the loosest in the config.
