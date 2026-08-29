---
task: "W5 — the remaining hard panes, plus three pieces of user feedback"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §4 W5
source: "docs/research/Sesame Lab_ responsive UI_UX research brief.md — Hard-pane behavior"
follows: docs/findings/W8-four-pieces-of-feedback.md
amends: docs/findings/W7-module-first-shell.md §11.4, docs/findings/W2-container-queries.md §4
---

# W5 — Signal, Inspector, Face, Lab, Source; and the panel the user sent back

**Two halves.** The plan's W5 is five panes. Half-way through it the user sent
three more things, two of which are defects and one of which corrects W7's side
panel; those came first, and they changed what "done" means for the Face card.

---

## 1. Signal — a sequence, and the number that made it one

### What the brief did not know

> *"Signal should become a sequence, not a collection of unrelated cards. The
> ordering and common fields are part of the trace's meaning."*

The brief describes this pane as *"eight layered rows"*. **Measured at a 534 px
pane at 1440×900, one wave renders 36 rows and 10,285 px of scroll** — because
four of the eight layers emit one row per joint:

| step | layer | rows | witness |
|---:|---|---:|---|
| 01–04 | `ui.command` … `movement.enter` | 1 each | its own |
| 05 | `servo.target` | **8** | byte-identical across all eight |
| 06 | `pwm.output` | **8** | byte-identical — and 640 characters long |
| 07 | `joint.target` | **8** | differs (each embeds a spatial name) |
| 08 | `visual.joint` | **8** | byte-identical |

So the same 640-character paragraph explaining that no pin has ever emitted this
pulse was drawn eight times, at 439 px a copy — 3,512 px of one sentence — and
nothing on screen said those eight boxes were one rung. The ladder was the one
thing the ladder did not show.

### What it is now

One `<li class="trace-step">` per layer, numbered `01`–`08`, on a continuous
spine, carrying the layer name, `LAYER_MEANING` (which until now existed only as
a `title` attribute and inside a closed `<details>`), and the layer's badge when
its lanes agree. The rows are `.trace-row` **lanes** inside their step and keep
every attribute they had. **The witness is hoisted to the step when every lane's
witness is the same string**, and stays on the lane when they differ — a data
question answered from the data, not a rule about which layers may have one.

Measured at the same 534 px pane: **10,285 px → 8,288 px, and 36 witness
paragraphs → 15.** At 900 px of pane it is 5,264.

Three shapes at W2's two thresholds, no third number:

| pane | lane | column head |
|---|---|---|
| < 32.5rem | the brief's *trace-step record* — one column, card-like, sequence carried by the rung | hidden |
| 32.5–45rem | two-line row: `event · provenance` then the value | hidden |
| ≥ 45rem | aligned columns `event | value | provenance·origin`, witness beneath, never truncated | `EVENT VALUE PROVENANCE·ORIGIN` |

`pwm.output` is untouched: still `INFERRED FOR EXPLANATION` on both backends,
still no LEDC channel number anywhere.

---

## 2. Inspector — the trade W2 flagged, settled

W2 gave this pane a container-query switch and recorded, without deciding, that
its record band had bought *"every column kept"* with *"no column left to
scan"*. Seven labelled lines a joint, eight joints, and nothing under anything.

**The decision: group, and pay one line per joint for the alignment.** A joint
is a three-line record — identity and channel, then the three numbers in three
equal `1fr` tracks, then the two badges — so `commanded` sits under `commanded`
on every joint. Measured, at the widths the sweep drives:

| container | W2's stack | W5's grouped record |
|---:|---:|---:|
| 320 px | 2,397 px | **2,065 px** |
| 400 px | 1,733 px | 1,903 px |
| 519 px | 1,571 px | 1,729 px |

**It is 10 % taller at 400 and 519 px and 14 % shorter at 320**, and that is
stated rather than smoothed: label-above-value costs a line per group, and it is
what buys the column. At 320 px the stack's own `label | value` pairs start
wrapping and the grid's tracks do not, which is where the crossover is.

**Also found, and worth more than the pixels:** the `prov` and `origin` columns
were unscoped. `JointView` is explicit that `provenance` is *"the provenance of
the event that last set `commandedDeg`"*, and read left to right the badge sat
closest to `measured` — the one value it says nothing about. `JOINT_COLUMNS`
carries a `scope` clause now (`of commanded`, `inferred`, `no sensor`), rendered
in the `<th>` in the table band and inside the in-cell label in the record band,
from the same single array. Twenty-four per-cell badges was the other reading of
the brief's *"adjacent to the relevant value"* and was rejected: the three
statuses are properties of the column, and repeating one fact eight times is the
mistake Signal was just corrected for.

**A measurement worth recording:** the Inspector's "more info" screen is
**760–894 px of pane at every window this project measures**. The record band is
reachable only by driving the pane. That is the honest scope of this decision.

---

## 3. Face — the integer-pixel zoom policy, and what W7 was actually shipping

`apps/web/src/oled/zoom.ts` is the policy: a ladder of `8 · 6 · 4 · 2 · 1`, and
the largest rung whose rendered size **fits** the measured slot. The zoom is
published from the computed number, not from the variant.

**The first thing it found was that `data-oled-zoom` had been a claim.** W7
shipped `data-oled-zoom={compact ? '2' : '4'}` on a canvas with
`width: 256px; max-width: 100%` in a slot that measures **227 px** — so the
panel card was rendering at **1.77×** while its own attribute said `2`. An
assertion against that attribute could not have failed. Two more fractional
zooms surfaced the same way once the box was read instead of the attribute: a
canvas shrunk to 397 px (3.10×) by a flex container's default `flex-shrink`, and
498 px (3.89×) by `[data-2d-surface] { max-inline-size: 100% }` capping the
content of the surface rather than the surface.

Measured, as shipped:

| surface | slot | zoom | what it is |
|---|---:|---:|---|
| Face card, every window | 271 px | **2×** (256×128) | a glass |
| the `ⓘ`/`4×` screen | 868 px | **6×** (768×384) | hover a pixel for its byte and bit |
| Lab editor, 1280×800 | 429 px | **4×** | pans |
| Lab editor, 1440×900 | 530 px | **4×** | |
| Lab editor, 1920×1080 | 776 px | **6×** | |
| Lab editor, 2560×1440 | 1090 px | **8×** | the brief's top row |

### The policy call, and what it costs the learner

**The Face card commits to 2× and is therefore declared a glass, not an
editor.** There is no arrangement of a 280 px panel in which a 128 px-wide
bitmap is directly manipulable, so rather than pretend otherwise, every
pixel-level affordance — the GDDRAM byte/bit read-out, the editor — lives on a
surface that clears 4×. **An editor holds 4× and pans**; `EDITOR_MIN_ZOOM` is
the brief's own bottom row (*"<540px: keep 4× and use horizontal pan"*), and it
exists because a plain largest-that-fits ladder hands a 1440 laptop **2×** by
six pixels, which is worse than the 3.89× it replaces.

**What the learner loses:** the glass no longer grows to fill its box. Between
two rungs up to 127 px of the slot goes unused, and on a short panel the card
would step rather than glide. The card also gives back 22 px of padding on each
side to reach 2× at all, so the glass touches the card's edge.

**What the learner gains:** every bitmap pixel is the same number of device
pixels. At 2.94× the browser paints some three device pixels wide and some two,
the SSD1306's eight page-grid lines fall *between* device pixels, and the byte
arithmetic printed under the canvas stops describing what is on the screen. That
grid is the whole reason the pane exists.

Twelve unit tests cover the ladder, including the four fractional zooms above as
values `isIntegerOledZoom` must reject.

---

## 4. Lab — responsive to the data model, and one defect

**A defect first.** `.lab-body` was an implicit `auto` grid track, which sizes to
its item's max-content: with the Pose tab open, **the Lab pane's own
`scrollWidth` ran 320 px past its `clientWidth`** at 1440×900, so
`.pose-table`'s `overflow-x: auto` never engaged and the nine-column table
pushed the whole module column sideways instead of scrolling inside it.
`minmax(0, 1fr)` fixes it; the harness now asserts 0 px of pane overflow on all
five tabs at all six windows (30 tab/window pairs).

**The editors declare themselves.** `.pose-table` and `.sequence-table` carry
`data-2d-surface="table"` — a derivation read left to right and a timeline are
intrinsically spatial, and the brief is explicit that compressing them is the
failure. Both pin their identity columns (`ch`/`joint`, and the frame number) so
a panned table is not a grid of numbers belonging to nothing.

**The pixel editor is operable from the keyboard.** WCAG 2.2's *Dragging
Movements* asks for a single-pointer alternative and there was none: the canvas
was not focusable and had no `keydown` handler, so a reader who cannot drag could
not set one pixel of 8,192. It is focusable now; arrows move a caret (Alt for
eight), `Space`/`Enter` toggles, `Shift`+arrow paints, and the caret's
coordinate and GDDRAM byte/bit are in a live region — a caret nobody can read is
not an alternative to anything. Driven end to end in phase 10.

**Verified, not changed:** the pose sliders are `<input type="range">` and were
already keyboard-operable; the API console and the C++ export are `<textarea>`s
with `white-space: pre; overflow-x: auto`, which is the brief's rule for payload
text.

---

## 5. Source — verified, and deliberately left alone

The brief's C10 is *"keep code unwrapped by default, allow horizontal scrolling,
do not solve the problem with a narrower or smaller font"*. W8 built the
outline-beside-code arrangement; what remained was to check the rest holds, and
it does: `.src-line` computes `white-space: pre`, `.source-code` is the declared
two-dimensional surface, and the type is `--font-code` (15 px).

The whole of it reduces to one computed value, so that value is now read at all
eleven swept container widths — because `pre-wrap` at a narrow container is
exactly what a future "responsive fix" would reach for, and a wrapped line
silently renumbers the file a reader is comparing against
`hardware/source-annotations.json`.

**The Wrap Lines toggle the brief also suggests is not built.** It is an
addition rather than a defect, and the instruction for this pane was to verify
and leave it alone.

---

## 6. The two hand-overs

**W4's `Modules ● 0 expanded`** — already closed, by W7 rather than by W5. The
badge is `selection.nodeId` now, so the Modules pane's note is the selected node
or nothing, and the count of a concept the causal path does not have is gone.
Verified in the browser: the module notes read `8 steps · 36 rows`,
`19 lessons`, `robot unmodified`, and Architecture's is empty until something is
selected.

**W3's redundant pane title** — *not* closed, and the brief's assumption that it
was is what made it worth measuring. W7's rule was structural —
`.module-content > .panel > .panel-header > h2` — so it caught the three panes
whose panel is a direct child of the module content and **missed Learn and Lab**,
whose headers sit one level deeper. Both were still printing their own name
under the column's at every window.

Widening the selector was not available: `LessonRunner`'s second
`.panel-header > h2` is the **lesson title**, and a depth-agnostic rule would
have hidden that with it. So the echo says it is an echo — `panel-title-echo` on
the five components that name themselves — and the harness compares rendered
text rather than trusting a selector. **2 echoes before, 0 after**, at every
window, in every module.

---

## 7. The user's three, taken first

### 7.1 The flicker was two sets of pixels, not one unstable label

> *"The face is occasionally flickering between inferred and observed."*

Confirmed. `TelemetryStore` writes `oledSource` from two independent paths, and
under the default `cli-oled` image **both fire for the same face change**: the
`face.expression` event arrives, the app renders `face-bitmaps.h` host-side and
labels those pixels `inferred`; milliseconds later the guest's own `oled.frame`
lands and the same panel is relabelled `observed`. The idle-blink state machine
repeats that pair every 120–220 ms.

**Neither label was wrong.** Each was true about the pixels that had just been
drawn. So a debounce or a transition would have made a correct label lag — the
fix is to stop drawing the second set.

`declareOledFramebuffer(boolean)`, pushed in from the one place that knows the
capability document: when the backend declares `oledFramebuffer`, a face NAME is
no longer a reason to render anything. The panel keeps what it holds until the
real bytes arrive, which is also what the glass does.

**It is a capability, not a history.** The alternative — latch to `wire` after
the first frame ever seen — was rejected for being an inference from behaviour:
a backend that sends one frame and then only names would go on claiming
`observed` about pixels nothing transmitted, which is the exact failure
`pixelOrigin` exists to prevent. The simulator, the bridge and the older `cli`
image keep the host render and the honest `inferred`, unchanged.

Eleven unit tests, and the one that matters has a sibling asserting the OLD
behaviour: `alternating face/frame events leave one steady claim` passes only
with the declaration, and `...and WITHOUT the declaration the same sequence
really does alternate` proves the first is measuring the fix rather than a
constant.

### 7.2 The layout shift was a separate bug, and the face name caused it

> *"its html container resizes causing everything else to shift position,
> bouncing up and down."*

Measured on the shipped build at 1440×900, with no QEMU involved:

| `setFace(…)` | Face card | its header | Commands card | wave button |
|---|---:|---:|---:|---:|
| `happy` | 213 px | 41 px | 292 px | 56×80 |
| `sleepy` | **241 px** | **69 px** | **264 px** | **56×65** |
| `surprised` | 241 px | 69 px | 264 px | 56×65 |
| `idle` | 213 px | 41 px | 292 px | 56×80 |

One extra character re-wrapped a 262 px flex row, and the firmware's idle-blink
animation changes that name several times a second. The face name moved into the
card's **body**, on a row that is one line tall whatever it says; the one
remaining variable-length element on any card header — the provenance word,
where `simulated` is one character longer than `observed` — is pinned to a
constant width in `ch`. The name is not a correctness surface; the badge beside
it is, and the badge did not move.

**After: 243 px at every one of the four names, header 41 px, and the card below
starts at the same pixel.** Asserted at every window as a count of distinct
heights, which is 1.

### 7.3 The side panel: the fold is gone, and W7's invariant is replaced

> *"We want to see all the commands where possible and fit the available space
> with commands. All other sections should be large enough that they don't need
> to change size. Use scrollbars in command and selected joint only if there
> isn't enough space to show all content. The command buttons should be minimal
> size like they used to be."*

W7 answered §11.4's *"never its own scrollbar"* with a measurement: cards folded
in a priority order until the content fitted, and one elastic card grew into
what was left. It was correct about the constraint it was given and it is the
wrong shape, for the reason §7.2's table shows — **every card's height became a
function of every other card's content.**

The replacement has no measurement in it at all. A `useLayoutEffect`, a piece of
fold state, a `ResizeObserver` and two published numbers are deleted, and three
flex rules take their place:

| card | flex | scrolls |
|---|---|---|
| Face, Driving | `0 0 auto` — its own content's height, always | never |
| **Commands** | `1 1 auto` — takes the height nothing else needs | when its content does not fit |
| **Selected joint** | `0 1 auto` — gives height back first | when its content does not fit |

**Commands shows all 19 commands plus `stop`**, not W7's four, and the buttons
are back to 56×36 from 56×80 — the inflation was the elastic card's
`grid-auto-rows: minmax(36px, 1fr)` with `align-content: stretch`, which handed
four buttons a whole card to divide. **Nothing became smaller than 14 px:** the
compaction is padding and gap, the type is `--font-ui` throughout, and `min-block-size: 36px`
keeps the brief's fine-pointer target.

**W7's `zero scrollers AND zero overflow` invariant is DELETED, not relaxed.**
Leaving it would have kept it passing against a design that no longer holds it,
which is the hollow-assertion failure this project has hit three times. The
replacement is narrower and is three claims: no scroller anywhere on the panel
outside the two cards that declare themselves scrollable; those two scroll when,
and only when, their own content exceeds the box flex gave them; and the panel's
own box still never overflows.

---

## 8. Assertions that had to fail first

Five, and three of them found something:

1. **`data-oled-zoom` against the rendered box.** Failed immediately on the
   shipped build: `claimed: 2, rendered 227 px = 1.77×`. Then failed twice more
   during the fix — 397 px (3.10×) from a flex item's default `flex-shrink`, and
   498 px (3.89×) from `[data-2d-surface] { max-inline-size: 100% }` capping the
   canvas. Every one was a fractional zoom the attribute was reporting as an
   integer.
2. **The pane-title echo scan.** 2 before, 0 after. It is a comparison of
   rendered text on both sides, so it cannot be satisfied by moving a CSS rule.
3. **The Face card's height across four face names.** 213 / 241 / 241 / 213
   before, 243 / 243 / 243 / 243 after, and the card below it started at four
   different pixels.
4. **The Lab's per-tab pane overflow.** 320 px on the Pose tab before.
5. **The pixel editor's keyboard path.** Could not have passed: there was no
   `keydown` handler and the canvas was not focusable. Its own first version
   then failed for a *different* reason — it asserted an absolute caret position
   of `(3, 0)` and got `(25, 22)`, because the caret carries over from the
   pointer drag above it. That is correct behaviour and the check was wrong; it
   asserts the movement now, which is the stronger claim.

## 9. Assertions that changed meaning, said out loud

- **`traceRowDisplay` / `traceHeadWrap`** (W2). `.trace-row-head` no longer
  exists, and `.trace-row`'s `display` is `grid` in all three bands now, so that
  check would have passed while measuring nothing. Both are replaced by
  `traceLaneTracks` — 1 / 2 / 3 column tracks at the two thresholds — plus the
  brief's own four requirements: every lane carries all six required fields at
  every width, no witness is clipped, the steps are numbered `1..N` in
  non-decreasing causal rank, and at the wide band the column head shares one
  left edge with every lane's provenance field.
- **The side panel's `scrollers.length === 0`** (W7). Deleted; §7.3.
- **`commandsPx >= commandsContentPx`** (W8 — *"the elastic card may only ever
  grow"*). Deleted. It was the right rule for a card forbidden a scrollbar and
  is a false one for a card that has been given one: a 197 px Commands card
  around 571 px of content is correct at 2560×900 and would have failed it. The
  conditional replaces it.
- **`data-folded`** is gone from the DOM and from `PanelReading`, rather than
  left reporting a constant `false` about a mechanism that no longer exists.

## 10. Verification

- `pnpm -r run test` — **1,031 passing** (was 1,008): +12 `oled-zoom.test.ts`,
  +11 `oled-flicker.test.ts`.
- `pnpm run typecheck` — clean.
- `node scripts/capture-web-screenshots.mjs` — **38 captures, 0 problems**, full
  run with QEMU. The two NOTEs it prints are W4's and W1's, unchanged: the full
  63-node graph still draws at 10.94 px when fitted, and lesson prose cannot
  reach 45 ch at the two narrowest DRIVEN container widths.
- What the harness asserts that it did not before: the Signal ladder's lane
  track count at the two thresholds, its step numbering and causal order, its
  six required fields per lane, that no witness is clipped and that the column
  head shares one left edge with every lane's provenance field; the Inspector's
  seven laid-out cells, its one `commanded` left edge and its column scopes in
  both bands; **every 128×64 surface's rendered box against the zoom it
  claims** — 47 of them at `[8, 6, 4, 2]` across six windows; **0 echoed pane
  titles** in five modules at six windows; the Lab's five editor tabs at 0 px of
  pane overflow with every horizontal scroller declared, 30 tab/window pairs;
  the pixel editor driven with arrow keys and Space; the Face card's height
  across four face names; and the side panel's narrowed scroll rule.
- Every pre-existing assertion still holds, including ISSUE-20260823-023 at
  every breakpoint and across every module switch, W8's graph zoom across a node
  click, W4's three representations, W2's 0 viewport-dependent pane differences,
  W1's type floor, and the QEMU leg's `origin.kind="emulator"` with
  `isPhysicallyObserved()` false. The QEMU OLED still reads `wire` → `observed`
  with the flicker fix in place, which is the leg that proves the fix removed
  the host render and not the framebuffer.
- **Zero new dependencies.** The lockfile is untouched.

## 11. Not done, and why

- **No Wrap Lines toggle in Source.** §5.
- **The Inspector's record band is 10 % taller at 400–519 px than the stack it
  replaces.** §2, with both numbers.
- **Between two rungs of the zoom ladder the slot keeps its slack** — up to
  127 px. §3; it is the trade the brief asks for by name.
- **The subsystem graph's frame at 1920×1080 and the full graph's fitted label
  size** are still W7's and W8's open items, untouched here.
