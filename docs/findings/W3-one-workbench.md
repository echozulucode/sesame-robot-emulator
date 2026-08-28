---
task: "W3 — one laptop workbench"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §3, §4 W3, §7
source: "docs/research/Sesame Lab_ responsive UI_UX research brief.md"
follows: docs/findings/W2-container-queries.md
amends: docs/findings/U6-two-dock-shell.md
---

# W3 — one workbench, in flow, and the metric that had to change with it

**Trigger:** §3 of the plan, resolved by the user.

> *"I'd rather the robot area shrink. 50% of the screen area is more than enough."*

That sentence decides the layout by arithmetic. At 1440×900 with a 64 px rail and a
32 px status strip, two 360 px docks leave the stage **43.9 %** of the screen area and
two 320 px docks leave **49.3 %**; one 540 px workbench leaves **56.0 %**. Two docks are
not available on a laptop at any usable dock width, so the brief's recommendation and the
user's rule arrive at the same shell from opposite directions — and W2 had already
re-derived it a third time from prose measure.

---

## 1. The three regimes, as built

| Width | Shell | Workbench | Stage |
|---|---|---|---|
| **< 1200 px** Compact | one workbench, **sheet over the stage** | `min(640px, 86vw)`, shut by default | full width; §7's area rule does not apply, the 45vh/480px floors do |
| **1200–1699 px** Medium | **one workbench, IN FLOW** | `clamp(500px, 37.5vw, 560px)`, **open** by default, inset 12 px | genuinely resizes; ≥ 50 % of the screen area |
| **≥ 1700 px** Wide | **U6's two docks**, unchanged | 320–560 px each, resizable, persisted | ≥ 1276 px |

`--workbench-w: clamp(500px, 37.5vw, 560px)` **is** the brief's triple: 37.5vw is exactly
540 px at 1440, and 500/560 are its stated minimum and maximum. One `clamp()` rather than
three media queries, because a stepped width has a wrong value on one side of every step.

### Why the boundaries moved, and the arithmetic that moved them

**Wide 1440 → 1700.** Two 360 px docks plus a 64 px rail need ~1700 px before the stage
clears 50 % of the area. Below that the two-dock shell cannot satisfy the user's rule, so
below that it is not offered.

**Compact 899 → 1199.** The floor arithmetic is 64 + 500 + 480 = 1044, but that is not the
binding constraint. With a 32 px strip the stage needs about **52.5 % of the width** to
reach 50 % of the *area*, which caps the workbench at `0.476W − 64`; the brief's 500 px
minimum stops fitting at about **1185 px**. So 1200 is the first width at which an in-flow
workbench, the brief's 500 px floor and the user's 50 % rule are all satisfiable at once,
and below it the workbench goes back to being a sheet.

## 2. Measured, in a real browser

Read off the live page — the **canvas element's own rect**, not its container — with the
workbench in Analyze. `innerWidth`/`innerHeight` are what the browser gives a window of
that size, which is why 1440 measures 1414.

| Window | inner | Workbench | Canvas | **Stage area** | Height share |
|---|---|---:|---|---:|---:|
| 880 × 900 Compact | 854 × 807 | 640 (sheet) | 746 × 775 | 83.9 % | 96.0 % |
| **1280 × 800** | 1254 × 707 | **500** | 690 × 675 | **52.5 %** | 95.5 % |
| **1440 × 900** | 1414 × 807 | **530** | 820 × 775 | **55.7 %** | 96.0 % |
| **1600 × 1000** | 1574 × 907 | **560** | 950 × 875 | **58.2 %** | 96.5 % |
| **2560 × 1440** Wide | 2534 × 1347 | two docks | 1966 × 1315 | **75.7 %** | 97.6 % |

And the stage really gives the width up — 456 px at 1280, 486 px at 1440, 516 px at 1600.
At Compact it gives 0.0 px, because there it is still a sheet.

**Lesson prose at 1440 × 900: 465.3 px of 17 px text in a 489 px pane — 50.7 ch.** W1
measured about 25 ch in the two-dock shell and W2 recorded 40.4 ch at the analysis dock's
default width as a NOTE it could not fix. It is inside the brief's 45–75 band at every
Medium width: 47.4 ch at 1280, 50.7 at 1440, 53.6 at 1600.

## 3. Control | Analyze, and the section navigator

The brief: *"preserve Control and Analyze as top-level concepts, but make them two modes of
a single laptop workbench"*, and *"use tabs or a compact section navigator before using
nested accordions"*.

```text
  Control | Analyze                    [>]     mode switch, 36 px, 2 radio segments
  Inspector  Modules  Signal  Source  Learn    the navigator, tabs, this mode only
  ─────────────────────────────────────────
  SIGNAL                          8 rows       the pane title — an h2, not a toggle
  ...the pane, and nothing else
```

**The mode is derived, never stored.** Below Wide exactly one section is open and a section
belongs to exactly one dock, so `modeForState()` is `dockForSection(openSection)`. There is
no second machine to keep in step with the first — `mode: 'analyze', open: 'commands'` is a
state this shell cannot reach — no migration, no validation, and the mode survives a reload
for free because the open section does. Switching mode is `withDockOpen()`, which U6 had
already written and unit-tested: it shuts the other dock and opens the first pane of the one
being shown.

**The navigator carries §5.1.** U6's rule was that a selection landing in a collapsed pane
is still announced on that pane's header. There are no collapsed headers below Wide any
more, so the badge is rendered on the **navigator tab** — `Inspector ● R4` — and, when the
selection landed in the *other* mode, as a dot on the mode switch. Both places carry the
same `data-dock-badge="<id>"`, so `shell()` reads it with one document-wide lookup and the
harness's assertion is measured against whatever is actually on screen.

Only **selection** badges reach the navigator, never counts. `Modules ● R4` is the thing a
reader would otherwise miss; "20 commands" beside every tab is the density the brief is
complaining about. The count is still on the pane's own title, where the pane is.

**Panes are still mounted.** `data-open="false"` is `display: none` on the `<section>` —
the same relationship the accordion's `hidden` body had, and load-bearing in the same four
places (L4's `.src-line` refusal count, L6's mid-movement sampling, L4's single
`concept-text`, V8's drawn quaternion). Asserted: at Medium exactly **one** `[data-pane-content]`
has a laid-out box, and there are **zero** `.dock-section-toggle` accordion headers.

## 4. The status strip, and the environment line

The strip is **32 px** and it now spans the whole shell, under the rail, the stage and the
workbench, rather than sitting inside the stage. Two reasons: it is the plan's own geometry
(§3 computes 900 − 32 = 868 of stage height), and the environment line needs the width.

```text
SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE
```

Neither half is a slogan. The system name is derived from the **driving `TelemetryOrigin`**
— the same object the badges render — and falls back to the selected backend only before
anything has driven the scene. The second half is `store.physicallyObservedEvents`, a
counter: if it were ever non-zero the line would say `PHYSICAL HARDWARE: n OBSERVED EVENTS`
rather than keeping the reassuring word.

Asserted three ways: it is in the harness's **correctness-selector list**, so any window
where it is ellipsised, clamped or cut fails the run; its shape is matched against
`/^SYSTEM: .+ · PHYSICAL HARDWARE: (NONE|\d+ OBSERVED EVENTS)$/` at every window; and the
QEMU phase — the one run where real firmware is producing the telemetry, and therefore the
one where reading *"observed"* as *observed on hardware* would cost the most — asserts the
plan's literal string. It passes: `SYSTEM: QEMU EMULATOR · PHYSICAL HARDWARE: NONE`, not cut.

**One thing this cost, and it is worth recording.** The first version was `inline-flex` with
a `gap`, which looked right and rendered `SYSTEM:HOST MODEL·PHYSICAL HARDWARE:NONE` to
`textContent`, to a screen reader and to anyone copying it — because a flex item is
blockified and a block box drops its trailing whitespace. It is `display: inline` with real
spaces in the text now. A correctness surface has to be correct in the accessibility tree
too, and this one was caught by reading a probe's output rather than by any assertion; the
shape regex above is what would catch it next time.

The rail is **64 px**, the brief's number, reached by spending the horizontal padding rather
than the width: 2 px of side padding leaves 60 px of usable column, which still fits
"emulated" whole at the 14 px floor. W1 had needed 72 px for that.

## 5. The metric — what was deleted and what replaced it

**`overlay-not-push` is gone.** Not relaxed, not scoped to Compact — deleted. It asserted
that the stage's measured width was identical with the docks shut and with each one open,
which W3 makes false by design. §7 is explicit that leaving it green below Wide would be
the third hollow assertion this project has hit, and it would have gone on passing at
Compact while saying nothing about the laptop it was written for.

| | Before | Now |
|---|---|---|
| headline | canvas height ≥ 45 % of window height | **canvas AREA ≥ 50 % of window area**, Medium and above |
| the in-flow claim | *(none — the layout overlaid)* | the stage must **lose > 300 px** of canvas when the workbench opens |
| overlay | `overlay-not-push` below Wide | **deleted**; `dockOverlays` is asserted to be true only at Compact |
| Compact | — | `min-height: 45vh`, `min-width: min(480px, 100%)`, both kept, both still asserted everywhere |

The inverse check is the important half. A share is only honest if the box is really there:
without "the stage must actually shrink", a 55.7 % reading is exactly what a full-bleed
canvas behind an opaque panel would also produce, which is the failure §7 retired the old
metric for.

**ISSUE-20260823-023 gained a breakpoint rather than losing one.** The canvas now resizes
for real, so phase 12 sweeps the world frame at every breakpoint, across a resize of *each*
dock at Wide, and — new — **across a workbench close/open and a Control↔Analyze switch at
Compact and Medium**, which is a path that did not exist while the docks floated. Ground
plane, GLB root, orbit target and camera: **0.000000 mm** while the foot contact swept
37.535 mm, at all of them.

## 6. What W2 handed over, and what it was worth

Both hand-offs paid.

**`[data-sections='one'|'many']`.** The workbench is `one` by definition. Every rule keyed
on it — the Source pane's two height regimes, the arch canvas, the lab code block, scroll
ownership, pane spacing — went on working when W3 changed what *sets* the attribute.
**Zero pane rules were edited.** `.docks` still wraps both regimes and still publishes it,
which is why: the wrapper did not have to move for the thing inside it to change.

**`.stage` is `flex: 1 1 0`.** Not regressed, and it is now the declaration the whole layout
rests on: with `1 1 auto` the stage's basis would be the last width the WebGL canvas was
given, the row would overflow, and the flex difference would come out of the workbench —
which is a 540 px workbench rendering at 306 px, and the layout disagreeing with the model.

## 7. Verification

- `pnpm -r run test` — **959 passing**, up from 948. Eleven new: the moved breakpoints with
  their arithmetic, `usesWorkbench()`, the derived mode (including that it survives a
  reload and falls back to Control), the brief's workbench triple with §3's table
  recomputed rather than quoted, and the environment line's two halves.
- `pnpm run typecheck` / `pnpm run lint` — clean.
- `node scripts/capture-web-screenshots.mjs` — **33 captures, 0 problems**, full run with
  QEMU. Was 32; the extra one is the new **1600 × 1000** window, added because the regimes
  moved and it is now the top of the workbench band (and, until this change, the default
  session).
- The default harness session moved **1600 → 1760 × 1000**. Phases 1–11 assert
  `breakpoint === 'wide'` because phase 7 needs the architecture graph and the Signal trace
  on screen at once; 1600 is Medium now. This reframes 26 captures and changes what none of
  them asserts.
- **Zero new dependencies.**

Two NOTEs, both inherited and both unchanged: W1's architecture-graph zoom debt (W4's), and
the prose measure at the two *dock* widths at Wide — which now reads as a statement about
the wide-desktop regime rather than about the laptop, because the laptop is 50.7 ch.

Every pre-existing assertion still holds: L4's three source registers and its code-view
scroll, U6's selection badges and its `origin === 'scene'`-only auto-expand (still
analysis-only — a selection may reveal the pane that explains it and may never yank the
controls away), one open pane behind one scrollbar, `wave` hit-tested and reachable with
the workbench shut, reload persistence for both dock widths, W1's type floor and
no-truncation rules, W2's container/media split and its 0 viewport-dependent pane
differences, lesson 2 end to end at Medium, and the Lab's byte-exact C++ round trip at
Compact.

## 8. What the plan and the brief got wrong once it was on screen

- **The brief's safe-area occlusion model, and the CSS it shipped.** `\.stage { position:
  absolute; inset: 0 0 2rem var(--rail-w) }` with the workbench floating over it, plus an
  occlusion rectangle passed to the camera. §3 had already retired it in principle; on
  screen it is retired twice over, because an in-flow workbench means no scrim, no z-order,
  no `92vw` cap, no shadow and no second geometry for the camera to reason about. **The
  entire Medium media query is now empty** — the laptop regime needs no viewport rule at
  all beyond the one that selects it. That is worth stating as a result rather than as an
  omission.
- **"Workbench inset 12–16px above status strip"** assumes the strip spans the shell. It
  did not — it lived inside the stage. Moving it out is what made the plan's own arithmetic
  (`900 − 32 = 868`) true, and it is what gave the environment line room to be un-truncated
  at 880 px.
- **The plan's 1440×900 table ignores insets and browser chrome.** It predicts 836×868 and
  56.0 %; the measurement is 820×775 and 55.7 %, because a 1440 px window is a 1414 px
  viewport and 37.5vw of that is 530 rather than 540. The conclusion is unchanged and the
  margin is real, but the table is arithmetic on a screen size, not on a viewport.
- **§8's "viewport-share assertion replaced by safe-area occlusion, documented"** contradicts
  §3 and §7, which retire occlusion. It is a line that survived a rewrite. Corrected in
  place rather than ticked as written.
- **The pane title is now visibly redundant with several panes' own headings** — the
  workbench shows `COMMANDS` at 20 px and the Commands panel then says `COMMANDS` again.
  U6 had the same duplication at 12 px where nobody noticed. It is pane-internal chrome,
  so it is **W5's**, and it is the clearest single thing left on the laptop screen.
- **`Analyze` vs `Analysis`.** The brief writes the switch as two verbs, `CONTROL |
  ANALYZE`; the dock id, its aria label and `DOCK_SECTIONS` keep the noun. Both are right
  in their own place and neither was renamed to match the other, because renaming the id
  would have touched storage, the harness and eight sections for a label.

## 9. Handed on

**W4 — the representations.** The pane the architecture graph gets is now ~489 px at 1440
rather than ~399, which lands in `paneWidthBand()`'s middle band (520–719 → subsystem) at
1600 and in the narrow band below it. The graph is the one pane the workbench made *worse*
in one respect and better in another: it has more width than a dock, and it is no longer
allowed to share the column with Signal below 1700, so the cross-highlight between them is
a mode-preserving tab switch rather than a glance. That is exactly what W4's focus
workspace is for, and it is the strongest remaining argument for building it.

**W5 — the panes.** The duplicated pane title above. Also: the navigator is a five-tab row
at 14 px, which fits every Analyze label today; a sixth pane would wrap it to two lines,
and the row is `flex-wrap` rather than a horizontal scroller on purpose.

**W6 — the invariants.** `[data-testid="status-environment"]` is in the correctness-selector
list, `data-system` and `data-physically-observed` are published as data, and the mode
switch and navigator publish `data-workbench-mode` / `data-section-nav` / `aria-selected`
for anything that wants to assert against structure rather than text.
