---
task: "W8 — four pieces of user feedback on the shipped shell"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §11
follows: docs/findings/W7-module-first-shell.md
amends: docs/findings/W7-module-first-shell.md §5, docs/findings/L4-source-explorer.md §5
reads: docs/findings/EXP6-QEMU-oled.md
---

# W8 — four complaints, and the two measurements that were never measuring anything

**Trigger:** the user, minutes after W7 landed.

> 1. *"the source list file list should be adjusted. e.g. when
>    movement-sequences.h is select in SOURCE, the list of items, like
>    'runDancePose' should be in the left side of the Source pane and minified;
>    the right side should be all the source content, etc. which is presently
>    below it."*
> 2. *"The QEMU should be the default."*
> 3. *"Troubleshoot the 'These pixels did not come from the emulator' … how do we
>    fix this and also just show an info icon to click on and / or mouse over to
>    see the info. The face should be at the very top. Maximize the height of the
>    commands pane if it fits."*
> 4. *"the graph looks awesome. One complaint is that when I click on a node, it
>    zooms out and I need to keep manually zooming in."*

---

## 1. Source: the outline on the left, the code on the right

### The arrangement, and the one number it turns on

`@container pane (width >= 45rem)` — **W2's existing `wide` threshold, and no new
number.** The sweep's static check fails on a third one, and this question is
literally the one that band already names: *does this pane have room for two
columns?*

```text
< 720 px of pane                 >= 720 px of pane
+-----------------------+        +--------+--------------------+
| outline (minified)    |        |outline |   code             |
+-----------------------+        | 12rem  |   bounded, 420px   |
| code, line-budgeted   |        | at its +--------------------+
+-----------------------+        | natural|   context          |
| context               |        | height |                    |
+-----------------------+        +--------+--------------------+
```

It is also the honest threshold rather than the convenient one. At 45rem of pane
the content box is 696 px, the outline column is 12rem and the gap is 12, so the
code gets about 490 px — **more than the whole Source pane has at 1440×900
today** (510 px, all of it code). One band lower would give the code about
340 px, and `movement-sequences.h` runs to 96 columns: a two-column layout that
made every line scroll sideways would be a worse answer to this request than not
doing it at all.

### What that costs, measured rather than argued

The module column is `(innerWidth - 344) / 2 - 25`, so two columns need
`2 × (720 + 25) + 344 = 1834 px` of viewport. Measured in the shell, at the six
windows phase 12 sweeps:

| Window | pane | arrangement | outline | code |
|---|---:|---|---:|---|
| 880 × 900 (sheet) | 640 | stacked | 616 px wide, 284 tall | 616, content height |
| 1280 × 800 | 429 | stacked | 409 × 378 | 409, content height |
| 1440 × 900 | 534 | stacked | 510 × 374 | 510, content height |
| 1760 × 1000 | 694 | stacked | 670 × 263 | 670, content height |
| **1920 × 1080** | **774** | **two columns** | **192 × 761** | **546, bounded 420, scrolls** |
| **2560 × 1440** | **1094** | **two columns** | **192 × 831** | **866, bounded 420, scrolls** |

**1760 × 1000 misses it by 26 px of pane**, and that is stated rather than
smoothed away by moving the threshold. It is also the harness's own default
window, so the stacked fallback is the arrangement phases 1–11 exercise.

### The outline is minified at EVERY width, and that is where the complaint was

`repeat(auto-fill, minmax(11rem, 1fr))`. Intrinsic, so it is not a third
threshold and the static check has nothing to reject: the same declaration gives
a 510 px stacked pane two columns, a 670 px one three, and the 12rem left column
exactly one.

Before it, at 1440 × 900 with `movement-sequences.h` selected: **25 symbols, one
per row, each row 510 px wide with the name itself 468 px of it, and the outline
720 px TALL** — an index taller than the code it indexes. After: **374 px**. The
windows that do not reach the two-column arrangement still get that, which is
most of what the sentence was about.

The harness asserts the column count against the box rather than against a
table: `floor((W + 8) / (176 + 8))`, computed from the width the browser gave
the outline, at eleven driven container widths in two windows.

### What L4's "it scrolled there" now asserts, in each arrangement

L4 asserts that selecting a joint **scrolls the code view to the symbol's first
line**, measured as `0 <= target.top - container.top <= container.clientHeight`
on `.source-code`.

**In the stacked arrangement that assertion has been vacuous since W7, and W8
did not cause it.** `[data-sections='one']` gives the code box its content
height, so `scrollHeight === clientHeight`, `scrollTop` never moves, and every
rendered line satisfies the inequality. What it actually asserts there is the
**window**: the line-budget window recomputed around the selected symbol, which
is a real property — `renderedFirstLine <= startLine <= renderedLastLine` and
the painted text of the numbered line equals `startLineText` — and those are
separately asserted beside it.

**Beside the outline it is a scroll assertion again.** The code region is a
bounded 420 px `data-2d-surface` there, `codeScrolls` is measured as
`scrollHeight > clientHeight` and recorded per window, and the check means what
its message says. That is half the reason the two-column arrangement re-bounds
the box at all.

### One invariant had to be taught something

The module column's *"exactly one scrollable box"* check counted the code region
as a violation the moment it became a real viewport. W2's rule has always been
**one ORDINARY scroller, and anything else that scrolls must declare itself with
`data-2d-surface`** — the container sweep has read it that way since W2 — and
this check simply had no declared surface to meet until now. `scrollersIn()`
marks them `(2d)` and both call sites filter on the marker rather than dropping
the entry, so an undeclared scroller still fails and a new declared one is still
visible in the message.

---

## 2. QEMU by default, and the three things "default" has to mean

`useState<BackendId>('sim')` became `useState<BackendId>(DEFAULT_BACKEND)` with
`DEFAULT_BACKEND = 'qemu'`, and then the interesting part.

**Two arrangements this repository ships have no QEMU behind the origin.**
`just dev-sim` runs a lab host whose backend is the behavioural simulator, and
`pnpm demo:web` serves the built app from the bridge with no lab host at all. A
hard-coded `qemu` sits in an error state in the first while a perfectly good
robot answers on the same origin, and shows an unexplained failure in the
second — which is a problem a user of this project has already reported once.

So the default is **detected**, by one request to `/lab/session` on mount:

| what answers | opens on | and |
|---|---|---|
| `{"backend":"qemu"}` | `qemu` | nothing else |
| `{"backend":"sim"}` | `sim` | the detail says the lab host is running the simulator and *"nothing here is the emulator"* |
| a backend this app has no arm for | `qemu` | reported by name rather than mapped |
| 404, a network error, unparseable JSON | **`qemu`** | `labHost: 'absent'`, and the panel says so |

**The last row does not fall back to the simulator, and that is the decision
rather than the lazy path.** Landing on a host model because the emulator was
unreachable is exactly the substitution this project refuses everywhere else,
and a reader would have no way to tell a booted emulator from a model wearing
its name. Staying on QEMU and reporting `absent` is what turns the failure into
the existing guidance.

**The guidance is on the panel, not behind a disclosure.** W7 moved
`BackendPanel` — and with it `[data-testid="qemu-unreachable"]`, the paragraph
naming `node apps/web/server/lab-host.mjs` — into the Driving screen. That is
the right place for the paragraph and the wrong place for the claim, so the
trust card carries one line (*"No lab host on this origin, so there is no
emulator to drive"*) with a control that opens the screen holding the rest. The
harness reads it with every screen shut and asserts `insidePopover === false`.

A reader's own click pins the choice: `chooseBackend()` sets a ref the probe
checks, so a probe that resolves after a click cannot undo it.

**All three legs are asserted against real servers**, and none of them names a
constant:

- phase 1, served by the **bridge** with no lab host: opens `qemu`, and
  `[data-testid="panel-no-lab-host"]` is laid out on the panel and not inside a
  popover;
- phase 6, served by a **QEMU lab host**: opens `qemu`, and the guidance is
  *absent*;
- phase 11, served by a **`--backend sim` lab host**: opens `sim` — the leg that
  proves this is a detection rather than a constant.

Eleven unit tests cover the parsing, including the three ways a probe can fail.

### It cost the harness two honest lines

A `location.reload()` re-runs the probe, and phase 12's pages are bridge-served,
so the app comes back on QEMU with nothing driving it. Two reloads now
re-select the simulator explicitly, with the reason written down. Without it the
ISSUE-20260823-023 sweep sampled a robot nothing was commanding and **its own
vacuity guard caught it** — *"the foot contact varied by only 0.000 mm"* — which
is the guard doing precisely the job it was added for.

---

## 3. The OLED message, the real fix, and the info icon

### The message was true when W7 wrote it and is false now

A sibling workstream built a `cli-oled` QEMU image with the firmware's
`SESAME_TELEMETRY_OLED` hook enabled, and it is the default image. Under it the
emulator declares `oledFramebuffer: true`, drops `ssd1306-panel` from `elided`
and puts **`ssd1306-glass`** there instead — the device is still absent; only
the framebuffer is now observed.

**Nothing in this app changed for that to happen**, and that is the claim rather
than a hope. `oled/pixel-provenance.ts` derives the state from the capability
document and from what actually wrote the buffer:

| declared | pixels arrived as | state | what the pane says |
|---|---|---|---|
| `oledFramebuffer: false` or `ssd1306-panel` elided | `rendered` | `elided` | these pixels did not come from the emulator |
| `oledFramebuffer: true`, panel not elided | `wire` | **`observed`** | **these pixels came from the emulator — the buffer the firmware drew** |
| `oledFramebuffer: true`, panel not elided | `rendered` | `host-rendered` | drawn on the host from the firmware's own bitmaps |
| no emulator at all (sim, bridge) | any | `host-rendered` / `power-on` | no sentence about an emulator, because there is none |

Both branches were written and tested against a **fabricated** capability record
before an image existed that produced one — `oled-provenance.test.ts` flips the
two fields over the whole cross product — and then the real image arrived and the
harness read `state: "observed"` off a running emulator. The harness computes
what the pane *ought* to say from `emulatorFacts()` and asserts the pane agrees,
so neither side names an image and the older `cli` image flips both together.

**Two things the wording refuses to round off.** The hook reads `getBuffer()`
inside `updateFaceBitmap()`, **before** `display.display()` pushes it over I²C at
a chip that is not attached — so the screen says *this is what the firmware
handed to the driver*, never *this is what reached the glass*, and it names
`ssd1306-glass` as the reason. And `isPhysicallyObserved()` is still false for
every one of these events: the status line reads `PHYSICAL HARDWARE: NONE`
throughout, and the harness asserts `physicallyObservedEvents === 0` in the same
block that asserts the framebuffer is observed.

Phase 6's own two capability checks were **rewritten rather than updated**. They
used to demand `oledFramebuffer === false` and `elided.includes('ssd1306-panel')`
as constants, which is an assertion that fails on a product improvement. What is
invariant is asserted instead: exactly one of `ssd1306-panel` / `ssd1306-glass`
is in `elided`, the two statements agree, and the SSD1306 is never simply
unmentioned.

### What moved behind the icon, and what did not

| | where it is |
|---|---|
| the pixel-provenance **badge** (`inferred` / `observed`) | the Face card's header summary, at every width, folded or not |
| the derived **claim**, as one line | the icon's `title`, and its tip on hover and on focus |
| the **paragraphs** | the `ⓘ` screen — a fifth `<dialog>`, a sibling of the shell's columns |

§11.4 is the line: *a popover may EXPAND a correctness surface and may never be
where it first appears.* The badge is the claim, so the badge stays. What left
the panel is the `warn-short` block — a bold sentence and a line of explanation,
about 60 px of a panel that may never grow a scrollbar.

Asserted with every screen shut: the badge is laid out on the panel and equals
what the store says; the icon is on the panel and its title equals the derived
claim; **no element on the panel carries the explanation's vocabulary**
(`ssd1306`, `framebuffer`, `face-bitmaps`, `drawBitmap`); focusing the icon
reveals a tip equal to that same claim; clicking it opens a screen that contains
it plus the vocabulary. The one-line form and the long form come from one
object, so they cannot say different things — the discipline W7 applied to
`measurementHeadline()` / `measurementDetail()`.

**The tip is a `createPortal` into `document.body`**, and that is not a
preference. The side panel is `overflow: hidden` and every pane is
`container-type: inline-size`, which is `contain: layout`, which makes the pane a
containing block for its own fixed-position descendants — so a tip positioned
`fixed` from inside a card is both contained and clipped, invisible in exactly
the place the icon is most needed. `react-dom` has been a dependency since V3;
**zero new dependencies**.

Its first version hid on any scroll, captured document-wide, and the Source pane
scrolls its own code view whenever a symbol is selected — so the tip vanished
within 400 ms in the arrangement it was added for. It repositions instead.

### The face at the top, and the commands taking the slack

**Order: `Face · Driving · Commands · Selected joint`.** W7 drew the trust card
first and treated that as a consequence of §11.4. It is not one: §11.4 is about a
correctness surface being *on* the panel rather than behind a disclosure, and
says nothing about which card is first. All seven named surfaces are still read
with every screen shut at every window; only the order changed. `TRUST_BELOW` is
a named constant so this reads as a decision.

**Commands is `flex: 1 0 auto` — it grows and never shrinks.** The direction is
W7's own scar tissue: the elastic Face card was `0 1 auto`, was crushed to 10 px
on a short window, and *the crushing did not register*, because a
`container-type: inline-size` box does not contribute its overflow to an
ancestor. A card that can only grow has no equivalent failure. `24rem` caps it,
so a very tall panel keeps a tail instead of holding six buttons in 600 px.

| Window | panel | folded | Commands | unused tail | scrollers | overflow |
|---|---:|---|---:|---:|---:|---:|
| 880 × 900 sheet | 741 | Selected joint | 264 | 0 | 0 | 0 |
| 1280 × 800 | 641 | Face, Selected joint | 328 | 0 | 0 | 0 |
| 1440 × 900 | 741 | Selected joint | 272 | 0 | 0 | 0 |
| 1760 × 1000 | 841 | — | 218 | 0 | 0 | 0 |
| 1920 × 1080 | 921 | — | 298 | 0 | 0 | 0 |
| 2560 × 1440 | 1281 | — | **384** (the cap) | 265 | 0 | 0 |

The fold inventory is W7's, unchanged. `4×` replaced `Larger` on the Face card's
"more info" button for a measured reason: with the info icon added, `Larger`
wrapped the header to a second line at every window, and the 28 px that cost was
exactly what pushed the joint glance into a fold at 1760 × 1000.

### §5 of W7 is amended: the panel's slack was never being measured

W7 measured `inner.clientHeight - inner.scrollHeight` and called the positive
case *"there is room"*. **It is never positive.** `scrollHeight` is defined as at
least `clientHeight`, so on a panel with space to spare that expression is
exactly 0 and W7's unfold branch — the one its own findings call the fix that
made folding reversible — **could not fire once**. Reversibility was coming
entirely from the `ResizeObserver` reset, which is why nobody noticed.
Measured on the shipped build: 1408 px of panel holding 801 px of cards,
`scrollHeight` 1408, slack 0.

The replacement measures the boxes: the bottom of the last card against the
bottom of the inner box's content area, with `data-measuring` on the container
for the duration of one synchronous read so the elastic card's `flex-grow` is
held at 0 — a measurement taken in the presence of the thing being measured
returns 0 for a second reason.

**And the first version of that had the same shape.** `lastBottom` was
initialised to `contentBottom` and then maxed with the cards, so
`contentBottom - lastBottom` was `<= 0` by construction. Measured with it: a
775 px panel holding 546 px of cards reported slack 0 and left the Face card
folded with **229 px to spare** — the user's own request quietly undone by an
arithmetic that could not come out positive. It is `-Infinity` now, the fold
arithmetic is published on the DOM as `data-slack-px` and `data-natural-px`, and
the harness asserts the panel's tail and the elastic card's height against its
own content.

That is twice in two workstreams that a quantity bounded on the wrong side was
mistaken for a measurement. Publishing the number is what caught the second one
in four minutes rather than a screenshot at a time.

---

## 4. The graph: clicking a node zoomed out

A real defect, and it had **two** causes rather than one.

**1. `focusId` and `pathIds` were dependencies of the re-frame effect.** A node
click changes the selection, which changes both, which re-ran the effect, which
in `full` fell through to `fitView({ padding: 0.16 })` and refitted all 63 nodes.
They are read through refs now, so the frame chosen when the shape changes is
still the frame around the current focus and a selection is not an event that
re-frames.

**2. Selecting a node changes the SHAPE.** `applySelection` calls
`expansionsFor()` and opens whatever chain is needed to put the node on screen,
so `expanded` grows on a plain click and the effect legitimately runs. The fix is
that the effect branches on the **cause**, not on the diff:

| what changed | re-fit? |
|---|---|
| the mode, or the surface's width (W4's `widthKey`, the focus workspace) | yes |
| the reader pressed `+n` | yes — W4's rule, fit the subtree that opened |
| a selection | **no.** The viewport stays where the reader put it |

The `+n` path says so on the way past — `handleToggle` sets a ref — because both
paths end in the same `expanded` prop and the graph cannot tell them apart from
the value.

`RevealSelection` answers the selection, and it may only **pan**: it reads the
zoom in force and hands it straight back to `setCenter`, which is the one API
here that takes a zoom rather than computing one, and it only moves at all when
the node is outside the canvas. It fires on a change of `focusId` and on nothing
else — its first version also ran on layout changes, raced `Reframe`'s animated
`fitView`, read a zoom mid-flight and **froze the subsystem graph at 0.917**,
which the container sweep caught as 13.21 px labels in the one representation
whose whole claim is a zoom floor of 1. It also clamps to that floor.

### The assertion, in both representations

Phase 7 clicks a node and reads `archGraph().viewportZoom` — W7's published
transform, off the DOM — before and after. In the full graph the reader is first
zoomed **in past `fitView`'s answer**, because a click taken at the fitted zoom
cannot tell *"kept the zoom"* from *"refitted to the same number"*.

| representation | fitted | before the click | after |
|---|---:|---:|---:|
| subsystem (900 px driven pane) | — | 1.000 | **1.000** |
| full (focus workspace) | 0.348 | 0.501 | **0.501** |

Before the fix, that last row was **0.501 → 0.348**: the user's complaint, as a
number.

**A side effect worth recording.** The full graph's standing zoom debt — the
NOTE this harness prints every run — improved from **4.38 px** to **10.94 px** at
its worst, because the map is no longer refitted every time somebody asks about
a box in it. Still below the floor, still scoped, still reported.

The node click itself had to be rewritten too: a hand-built `MouseEvent` has
`view === null` and React Flow's drag machinery reads `sourceEvent.view.document`,
which threw into the page's error log. It uses `el.click()`, and it tries a list
of candidates rather than one id, because phase 7 drives the pane 440 px wider
than the column that holds it and part of the graph is genuinely off screen.

---

## 5. Verification

- `pnpm -r run test` — **1008 passing** (was 985 before this phase's two
  workstreams; +20 here, in `oled-provenance.test.ts` and
  `default-backend.test.ts`, +3 from the sibling).
- `pnpm run typecheck` / `pnpm run lint` — clean.
- `node scripts/capture-web-screenshots.mjs` — **38 captures, 0 problems**, full
  run with QEMU. Was 37; the new one is `w8-source-outline-beside-code.png`, the
  Source pane at 1920 × 1080 — the first window whose module column reaches
  720 px of pane. A rule with no picture of it is a rule a reader has to take on
  trust, and this is the one the user asked for by name.
- One capture was **renamed**: `v4-browser-qemu-oled-inferred.png` became
  `v4-browser-qemu-oled.png`. The old name asserted the answer, and the answer
  changed underneath it — that image now shows pixels the emulator really
  produced. Its caption is generated from what the run measured, so it cannot go
  stale the next time the image does, and V7's one reference to it says why.
- **Zero new dependencies.** The lockfile is untouched.

What the harness asserts that it did not before: the default backend on all
three kinds of origin, with the no-lab-host guidance read off the panel with
every screen shut; the OLED's pixel state derived from the emulator's own
capability document and compared against it; the badge on the panel, the
paragraph not on it, the tip on focus and the screen on click; the Source pane's
column count, its code region's overflow regime and its outline's column count
at eleven container widths in two windows, plus the arrangement each of the six
real windows gets; the side panel's card ORDER, its one elastic card, its unused
tail and that the elastic card is never shorter than its own content; and the
zoom across a node click in both representations that have a viewport.

Every pre-existing assertion still holds, including the ones that had to be
re-pointed: L4's three source registers and its refusal check, W7's seven named
correctness surfaces and its zero-scrollers/zero-overflow panel, W2's 0
viewport-dependent pane differences across a sweep that now includes Source,
W4's three representations and its subsystem zoom floor, W1's type floor, the
QEMU leg's `origin.kind="emulator"` with `isPhysicallyObserved()` false, and
ISSUE-20260823-023 at every breakpoint and across every module switch.

---

## 6. Not done, and why

- **1440 × 900, 1600 × 1000 and 1760 × 1000 do not get the two-column Source.**
  The arithmetic is in §1 and it is a threshold decision, not an effort one: at
  those widths the code column would be about 340 px against 96-column C++.
  Lowering the threshold to 32.5rem would also add nothing to the type of
  question W2's bands answer — it would just be worse. Those windows get the
  minified outline, which is where most of the complaint was.
- **The subsystem graph's FRAME is still wrong at 1920 × 1080** — the scoped
  neighbourhood is taller than the 52vh canvas at zoom 1, so the frame falls back
  and leaves most of a 750 × 490 box empty. That is W7's §11 hand-over,
  unchanged: it is a framing problem, not a zoom problem, and this workstream
  deliberately did not touch the frame while it was making selection stop
  touching it.
- **The full 63-node graph still draws below 14 px when fitted** — 10.94 px at
  its worst now. Improved rather than fixed, and improved as a side effect.
