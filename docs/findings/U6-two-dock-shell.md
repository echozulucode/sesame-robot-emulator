---
task: "U6 — two docks, a status line, and one scrollbar"
phase: 3
status: complete
date: 2026-08-27
owns: apps/web, scripts/capture-web-screenshots.mjs
amends: docs/findings/U1-U5-responsive-shell.md
---

# U6 — the second dock

**Trigger:** the same reader who reported the laptop, reading U1–U5's answer.

> *"I don't like the commands and OLED at the bottom. How about a second vertical
> dock next to the other one with similar functionality. You can add a thin
> bottom pane under the robot window with status based on the window size."*

> *"The present right pane also doesn't have good UX for medium sized screens.
> Everything is too small and too many scrollbars."*

> *"When I select one of the panes, the other should be collapsed... I'd rather
> have to scroll through the pane vertically on smaller screens than tiny
> content and many scrollbars."*

U1–U5 fixed the stage's **width** and then quietly took back its **height**: the
command vocabulary and the OLED went into a `clamp(120px, 20vh, 176px)` strip
under the robot — up to 176 px out of the one thing the change existed to
maximise. And the dock it built nested three scrollbars into a 460 px column.

---

## 1. Measured, before and after

Read off the live page: the **canvas element's own rect**, not the container's
CSS, and at four real browser windows rather than a CDP metrics override.

| Window | U1–U5 canvas | share | **Now** | **share** |
|---|---|---|---|---|
| 880 × 900 (Compact) | 754 × 662 | 82.0 % | 710 × 773 | **95.8 %** |
| 1280 × 800 (Medium) | 1154 × 566 | 80.0 % | 1110 × 673 | **95.2 %** |
| **1440 × 900 (the laptop)** | 1314 × 646 | **80.0 %** | 1270 × 773 | **95.8 %** |
| 2560 × 1440 (Wide) | 2018 × 1171 | 86.9 % | 1974 × 1313 | **97.5 %** |

The strip was 141–176 px of that at every size. The status line that replaced it
is **34 px**.

Width falls at Wide (2018 → 1974) because there are two docks in flow there and
the second one is real. It stays far above the 480 px floor, and the height share
— the number the plan asserts and the one the complaint was about — rose.

And neither dock costs the stage anything below Wide. Measured with both shut,
then with each one open:

| Window | Stage, both shut | control open | analysis open | Moved |
|---|---|---|---|---|
| 880 × 900 | 710 px | 710 px | 710 px | **0.0 px** |
| 1280 × 800 | 1110 px | 1110 px | 1110 px | **0.0 px** |
| 1440 × 900 | 1270 px | 1270 px | 1270 px | **0.0 px** |
| 2560 × 1440 | 2390 px | 2044 px | 1977 px | in flow at Wide, which is correct |

---

## 2. What was built

```text
┌──┬──────────────────────────┬─────────────┬───────────────┐
│  │                          │ CONTROL     │ ANALYSIS      │
│R │       CENTER STAGE       │ ▾ Commands  │ ▾ Inspector   │
│A │    3D robot (≥ 45vh)     │ ▸ Face      │ ▸ Modules     │
│I │                          │ ▸ Lab       │ ▸ Signal      │
│L ├──────────────────────────┤             │ ▸ Source      │
│  │  status line (34 px)     │             │ ▸ Learn       │
└──┴──────────────────────────┴─────────────┴───────────────┘
 56px      never < 45vh          0/44/400      0/44/460
```

**Dock ordering: control inboard.** The reading order is the robot, then the
surfaces that drive it, then the surfaces that explain it. On screen this is
clearly right — at Medium the control overlay is the narrower of the two and sits
against the robot, so pressing a command and watching the result is one glance
rather than a sweep across the analysis dock.

**What went where, and why.**

| Dock | Sections | The rule |
|---|---|---|
| `control` | `Commands`, `Face`, `Lab` | it **drives** this robot |
| `analysis` | `Inspector`, `Modules`, `Signal`, `Source`, `Learn` | it **explains** it |

`Lab` moved across from the analysis dock, which was the one judgement call in
the split. Three reasons: it is a pose editor and a fault injector, not a reading
surface; its pixel editor authors the very panel the `Face` section shows, so the
two belong adjacent; and it leaves the analysis dock as exactly the set of panes
that share one `SelectionState`. `Learn` stayed in the analysis dock for the
mirror-image reason — its steps cross-reference `Modules`, `Signal` and `Source`,
and at Wide those can all be open together only if they are in the same dock.

**The status line.** 34 px, one row, never scrolls, never wraps. Content by
breakpoint rather than by its own width, so what it shows is testable from
`window.__sesame.shell()`:

| Breakpoint | On the line |
|---|---|
| Compact | connection · provenance · origin · `wave` `stop` |
| Medium | + event count, physically-observed count, backend, board · `stand` `rest` |
| Wide | + joint summary, ground plane, boot attempts, origin engine |

Every value is a *summary* of something the inspector states in full, read from
the same store field — `status.connection`, `store.drivingProvenance`,
`store.drivingOrigin`, `store.physicallyObservedEvents` — so the rail chip, this
line and `#prov-banner` cannot disagree. Nothing here computes a verdict:
`isPhysicallyObserved()`, the `conceptual` badges, the NOT BUILT panels and the
modifying-this-robot banner were not touched.

---

## 3. `[data-command="wave"]` — resolved, not weakened

Moving the vocabulary into a dock that starts shut put the harness's *"`wave` is
reachable at every breakpoint without opening anything"* in direct tension. Two
things were done, and together they are **stronger** than what they replace.

**1. The real button is now clicked properly.** Phases 6 and 7 open the
`Commands` section first, then require the button to have a laid-out box **and**
be the topmost element at the centre of it, via `elementFromPoint`. The old check
was `querySelector !== null && !disabled` — which a `hidden` element inside a
collapsed section passes, because `HTMLElement.click()` fires on hidden elements.
That check could not have failed for the reason it existed.

**2. The status line carries the promise at every width.** A
`[data-quick-command]` cluster — `wave`, `stand`, `rest`, `stop` — named from
`COMMAND_VOCABULARY`, which is a checked mirror of `hardware/hardware-map.json`,
so a shortcut cannot name a command the firmware does not have
(`shell.test.ts` fails if one does). They are **not** `data-command`: that
attribute stays the single unambiguous handle on the vocabulary, so nothing in
the harness can click a shortcut when it meant the vocabulary, or the reverse.

**What phase 12 now asserts, in full:** with **both docks shut**, at every
breakpoint, a `wave` button on the status line is hit-test-reachable and enabled;
the harness then clicks it and requires telemetry to come back. That is the
original claim — a reader can make the robot move without opening anything —
checked against what a reader can actually press rather than against the DOM.

---

## 4. One pane, one scrollbar

The dock nested three scrollers: `.dock-body`, then `.dock-section-body`, then a
pane's own `overflow-y: auto` (`.arch-detail`, `.trace-rows`, `.source-context`,
`.source-code`, `.lesson-panel`, `.lab-panel`). A reader dragging a scrollbar
could not tell which of the three would move, and the inner ones had a few dozen
pixels of travel each.

Below Wide:

- **`.dock-body` is the only scrollable box in the dock.** Asserted, per dock,
  per breakpoint: `scrollers.length === 1` and it is `[dock-body-*]`.
- **One section is open across BOTH docks.** Opening `Commands` collapses
  `Learn` and shuts the analysis dock. It lives in `withSection`, not in CSS, and
  is unit-tested.
- **Every pane renders at its natural content height.** No inner `overflow-y`,
  no `flex: 1` fighting for a share of a short column.
- **The overlay is 620 px (control) / 720 px (analysis)**, capped at 84vw — up
  from `min(460px, 92vw)`. That width is free: the docks are out of flow below
  Wide, so it costs the stage nothing, which is exactly why it should be spent.
- **Type is larger, never smaller.** The dock body goes 13 → 14 px, code 11.5 →
  13, outline rows and controls 11.5 → 13.5, and truncation that made sense in a
  400 px gutter (`.source-outline-name`, `.joint-name`) is turned off.

At Wide the old arrangement stands, because V8's requirement stands: `Modules`
and `Signal` must be visible **at the same time**, which means each open section
bounds itself and each is its own scroller.

### `.source-code` — where the honest exception went

U5 recorded the source pane's three bounded rows (130 / `1fr` min 200 / 220 px)
as load-bearing, and the argument was exact: an auto-height row lets the code
region grow to all 429 lines of `movement-sequences.h` while L4's *"selecting a
joint scrolled the code to the symbol's first line"* assertion keeps passing and
stops meaning anything.

That argument still holds **at Wide, where L4 runs** — the harness's default
session is 1600 × 1000, the bounds are unchanged there, and L4's scroll assertion
is untouched.

Below Wide the code region is bounded by **line count** instead of pixels.
`SourceExplorer` already windowed the file (`MAX_RENDERED_LINES = 240`, because
`face-bitmaps.h` is 3,158 lines); it now takes a `lineBudget` prop — 140 below
Wide — announces the window it is showing (`showing lines 83–115 of 429`) and
offers a button to lift the budget. **The announcement is the bound**, and phase
12 asserts the rendered `.src-line` count equals the announced range and stays
under the budget, at every window below Wide. A cap a reader can read is a better
constraint than a mystery gutter, and unlike the pixel bound it is checked
against the thing that is actually in force at that width.

---

## 5. Preserved from U1–U5, deliberately

- **Stage floor** `min-height: 45vh` / `min-width: min(480px, 100%)`. With two
  docks this got harder, so `.stage` now carries the floor itself and both docks
  are `flex-shrink: 1`: **the robot's floor outranks the docks' widths**, and at
  a 1441 px Wide window with both dragged to 560 px it is the docks that give.
- **Overlay-not-push below Wide**, now measured once per dock: 0.0 px.
- **`Modules` and `Signal` open together at Wide** — asserted by phase 7, and
  the default open set still contains both.
- **Collapsed-header badges and auto-expand on `origin === 'scene'` only.**
  Unchanged, and phase 12 adds a check that the auto-expand never opens the
  **control** dock: a selection is something to read about, so it may reveal the
  pane that explains it and must never yank the controls away.
- **Sections collapse, they never unmount.** All four reasons in
  `ui/Shell.tsx`'s module comment still apply, and two new sections joined the
  set under the same rule.

---

## 6. Verification

`docs/findings/assets/v3-v4-browser-capture.json` → `phases.responsiveShell`.

| Check | Result |
|---|---|
| Canvas ≥ 45 % of window height, docks shut / control open / analysis open | 95.8 / 95.2 / 95.8 / 97.5 % |
| Canvas ≥ 480 px wide | 710 / 1110 / 1270 / 1974 px |
| Status line is a line, not a strip | 34 px at all four |
| **Both docks overlay, neither pushes** — stage width shut vs each open | **0.0 px** at Compact and both Mediums |
| **Exactly one scrollable box in the open dock**, Compact and Medium | 1 — `[dock-body-*]` |
| **Exactly one open section across both docks**, Compact and Medium | 1 |
| **No dock font smaller at Medium/Compact than at Wide** | 14 / 13 / 13.5 / 13.5 / 13 px vs 13 / 11.5 / 11.5 / 11 / 12 px |
| **`wave` hit-test-reachable with both docks shut**, then clicked | pass at all four; telemetry followed |
| Source pane's rendered lines equal its announced window | 33 lines, `showing lines 83–115 of 429` |
| Collapsed section carries the selection — `Inspector ● R4` | pass at all four |
| `selectJoint` from the 3D scene auto-expands `Modules`, and never the control dock | pass below Wide |
| Both docks' widths and the open section survive `location.reload()` | pass at all four |
| **ISSUE-20260823-023** — ground plane, GLB root, orbit target, camera | **0.000000 mm** while the foot contact swept 37.5 mm, at every breakpoint |
| **ISSUE-20260823-023 across a resize of EACH dock at Wide** | **0.000000 mm** |
| Both docks at their 560 px maximum still clear both floors | pass |
| Learn plays lesson 2 end to end at Medium — six checks, one driven to `failed` first | pass |
| A selection made from inside a lesson does not collapse the lesson | pass |
| Lab's C++ export re-parsed at Compact against the poses the sliders authored | 2 frames, 16 writes, byte-exact |

**948 workspace tests pass (36 shell tests, up from 22). 32 real-browser
captures, 0 problems, full run with QEMU** — a clicked button drove real firmware
under Espressif QEMU through the new shell and every joint it moved still carries
`origin.kind="emulator"` with `isPhysicallyObserved()` false.

### Captures

| File | What changed |
|---|---|
| `u5-shell-compact.png` | 880 × 900 — the control dock as a sheet, `Commands` up |
| `u5-shell-laptop-small.png` | 1280 × 800 |
| `u5-shell-laptop.png` | **1440 × 900 — the machine the complaint came from** |
| `u5-shell-desktop.png` | 2560 × 1440 — both docks in flow |
| `u5-learn-at-medium.png` | lesson 2 finished, `Learn` in a 720 px overlay |
| `u5-lab-at-compact.png` | the Lab sheet at 880 px — a control-dock section now |

The other 26 captures keep their framing and their assertions. Four of them
gained an `openSection`/`focusSection` call because the pane they are about moved
dock — the OLED into `Face`, the vocabulary into `Commands` — and one
(`v3-browser-qemu-commanded-wave.png`) now focuses the inspector, which is where
its evidence (the origin banner) lives.

**No assertion was dropped.** Two changed, and both are stated:

1. The `[data-command="wave"]` reachability check, replaced by the pair in §3.
2. **Phase 4's scene-vs-store comparison now converges instead of sampling
   once.** It read `sceneJoints()` immediately after `waitSceneCaughtUp()` while
   the bridge replay was still streaming, so the store could move between the
   "caught up" poll and the read — one run in three failed on `L2: scene 135° vs
   wire 90°`, a race rather than a defect, and exactly the false alarm
   `waitQuiescent()` already exists to prevent elsewhere in this file. It now
   polls the same comparison for up to 6 s and asserts the last reading. The
   claim — telemetry arriving over the WebSocket reaches the scene — is
   unchanged, and a stalled render loop still never converges, so the check that
   matters still fails. This is a pre-existing race the extra per-tick render
   work exposed rather than caused.

---

## 7. What the guidance got wrong on screen

- **"Give the open section the dock's full height at Medium."** Taken literally
  this squeezed the collapsed headers to nothing: `.dock-section` defaults to
  `flex: 0 1 auto`, so with one pane at natural height inside a shorter dock, the
  four collapsed siblings shrank below their content and the badges that §5
  depends on vanished. They are `flex: 0 0 auto` below Wide, and the open section
  simply follows them.
- **"One scroller between the dock frame and the content" — the section body.**
  The reader disagreed with that placement, and they were right: the section body
  as the scroller still means the pane is a bounded box. The dock body is the
  scroller and the panes have no height of their own.
- **"Nested scrollable ancestors ≤ 2."** A depth count passes with two scrollers
  side by side. The assertion counts scrollable **boxes** in the dock and
  requires exactly one.
- **A wider overlay alone did not fix legibility.** 460 → 720 px changed the
  number and not the experience; what changed the experience was removing the
  inner scrollers, opening one pane at a time, and raising the type. The reader
  said so before the second attempt shipped, which is why they are in the same
  change.
- **React Flow is not a scroller and must not be treated as one.** It is a pan
  surface that needs `overflow: hidden` and a fixed box to place nodes at real
  coordinates — L6's lesson clicks one of those nodes. It keeps its box below
  Wide; the box is just `52vh` instead of `180px`.

---

## 8. Files

| File | What |
|---|---|
| `apps/web/src/ui/shell-state.ts` | two docks, eight sections, one-open-across-both, `v2` storage |
| `apps/web/src/ui/Shell.tsx` | `useShell`, the rail, `Docks`, a parameterised `Dock` |
| `apps/web/src/ui/StatusBar.tsx` | **new** — the 34 px glance line and the quick-run cluster |
| `apps/web/src/ui/SourceExplorer.tsx` | `lineBudget` and the "show more" control |
| `apps/web/src/App.tsx` | two section arrays, the status line, the strip removed |
| `apps/web/src/styles.css` | two docks, the status line, one scroller, the legibility floor |
| `apps/web/src/debug-hook.ts` | per-dock `ShellReading`, scroller inventory, hit-tested quick commands |
| `apps/web/src/__tests__/shell.test.ts` | 36 tests (was 22) |
| `scripts/capture-web-screenshots.mjs` | phase 12 rewritten; `clickWaveButton`; dock-aware helpers |
| `docs/plans/phase-3-ui-ux-improvement.md` | §10, amending §2, §3, §4 and §8 |

**Zero dependencies added; the lockfile is untouched.** No colour, type scale or
register changed at Wide — L4's computed-style assertions on `description`,
`commentary` and `libraryEvidence` still pass unmodified. No provenance surface,
`isPhysicallyObserved()` branch, `conceptual` badge, NOT BUILT panel or
modifying-this-robot banner was touched.
