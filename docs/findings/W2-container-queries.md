---
task: "W2 — container queries and the pane structural contract"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §4 W2
source: "docs/research/Sesame Lab_ responsive UI_UX research brief.md"
follows: docs/findings/W1-typography-and-tokens.md
---

# W2 — container queries and the pane contract

**No dock-model changes.** W3 builds the one workbench; this workstream gives every
pane the machinery to answer questions about *its own width*, which is what makes W3
and W4 tractable. The one geometric change here is a `flex-basis`, and it is a defect
fix rather than a layout decision — see §3.

**Trigger:** W1's hand-off.

> *"At 1600×900 the two in-flow docks shrink to about 230 px each, which is roughly
> 25 characters of 17 px prose. […] That is a pane-width problem, not a type problem,
> and it is what container queries plus one workbench are for."*

---

## 1. The split, as built

The brief's table, and where each row now lives:

| Question | Mechanism | Where |
|---|---|---|
| phone / tablet / laptop / wide-desktop? | viewport media query | `shell` layer, `@media (max-width: 1440px \| 899px)` |
| rail vs bottom navigation | viewport | the rail never collapses; unchanged |
| docks overlay or in flow | viewport | `shell`, the same media block |
| **one pane owns the dock, or several share it** | **shell state** | `[data-sections='one' \| 'many']` on `.docks` |
| Signal's row: wrapped, aligned, or two-column | **container query** | `panes`, `@container pane` |
| Inspector: table or stacked joint records | **container query** | `panes` |
| Learn: explanation above or beside the control | **container query** | `panes` |
| Modules: path / subsystem / full graph | **container width → React** | `ui/use-container-width.ts`; W4 mounts |
| reduced motion | user-preference query | `overrides`; still W6's |

The one row that is not in the brief's table is the third-from-last group: **shell
state**. It exists because moving the below-Wide pane rules out of `@media` exposed
that several of them were never about the window at all. They are about whether one
pane owns the dock's height (natural height, the dock body scrolls) or several open
sections share it (each bounded). `Docks` publishes that from the same `isSingleOpen()`
the accordion already obeys, so the rules now say what they mean — and W3 can change
what *sets* it without touching anything that reads it.

**Nine `@container` rules, all naming the `pane` container, two thresholds.** The
harness parses the file and fails on an unnamed query (it would bind to whatever
containment context W3 or W4 adds next) and on a third threshold (that is how a
responsive system becomes forty unrelated numbers).

## 2. The pane structural contract

```html
<section class="pane" data-pane="signal" aria-labelledby="pane-signal-title">
  <h2 class="pane__header" data-pane-chrome="header">…<span id="pane-signal-title">Signal</span></h2>
  <div class="pane__content" data-pane-content="signal" data-scroll-owner="pane">…</div>
</section>
```

```css
.pane          { container: pane / inline-size; }
.pane__content { min-inline-size: 0; }
```

The dock-era class names stay alongside the contract ones. Renaming 3,000 lines of
selectors in the same change that introduces container queries is exactly the
"visual regressions become unattributable" mistake the brief warns against, and it is
the same argument that rules out Tailwind here.

**What had to change to adopt it.** Only the wrappers — `Shell.tsx` adds the classes,
`data-pane`, `aria-labelledby` and the two scroll-owner attributes to boxes that
already existed. `container-type: inline-size` applies layout containment, which makes
a pane a containing block for absolutely positioned descendants; the only absolutely
positioned thing inside a pane is `.arch-expand`, positioned against `.arch-node`, so
nothing moved. Two components needed real work, both because a container query needs
something to switch *between*: `JointInspector` renders its seven columns from one
`JOINT_COLUMNS` array so a stacked record can carry the same labels as the table head,
and `LessonRunner` gained two wrappers (`.lesson-step-read` / `.lesson-step-act`) so
the control can sit beside the prose without reordering the DOM.

### Scroll ownership, and what enforcing it found

The rule: **a pane owns at most one ordinary vertical scroller**, and anything else
that scrolls must declare itself with `data-2d-surface`. There are three declared
surfaces — `code` (429 lines of C++), `graph` (React Flow's pan surface) and `pixels`
(the 128×64 OLED).

U6 achieved this below Wide by hand, inside a media query. At Wide it was simply not
true, and had never been asserted. Measured, before:

| Pane, at 2560×1440 with the analysis dock's sections open | ordinary vertical scrollers |
|---|---:|
| Learn, Signal, Inspector, Face, Commands | 1 each |
| **Source** | **3** — `.source-outline`, `.source-context`, plus the pane |

And the Source pane was worse than a scrollbar count suggests. Its three bounded rows
(`minmax(0,130px) minmax(200px,1fr) minmax(0,220px)`) compress when the section shares
the dock column: the measurement was `.source-outline` and `.source-context` at
**clientHeight 0** and a code view **57 px tall holding 240 lines**. Three scrollbars,
none of them showing anything.

So the outline and the context render at their natural height inside the pane's own
scroller at every width, and the code keeps a bounded viewport — 420 px in the `many`
regime — because it is the declared two-dimensional surface and because L4's
*"selecting a joint scrolled the code to the symbol's first line"* assertion is
measured against exactly that box. Every pane is now one ordinary scroller, at every
window the harness visits.

## 3. The ~25 ch prose problem

Three things, only one of which is a container query.

**1. A `flex-basis`, and it was a bug.** `.stage` was `flex: 1 1 auto`, so its basis
was its content width — a WebGL canvas that keeps whatever width it was last given. At
1600×900 that basis was 844 px, the flex row overflowed, and the difference came out of
the only shrinkable items: the docks. The measured result was a dock **306 px wide
whose own state said 400**, while `clampDockWidth()` promises never to return less than
320. The layout and the model disagreeing is not a styling preference. `flex: 1 1 0`
gives the docks the width they claim and the stage the rest; they still shrink, but
only after the stage hits its own 480 px floor.

**2. `--measure-prose`, which W1 defined at 68 ch and left unused.** It is a cap, not a
width: a 649 px pane would otherwise run past 70 ch and keep going in W3's focus
workspace.

**3. The container query**, which decides whether the control sits beside the reading
column — and which caught its own first version. `minmax(0,1fr) minmax(18rem,24rem)`
looks reasonable and is wrong, because grid fills a non-flexible track to its growth
limit *before* it gives anything to an `fr` track: at exactly 720 px of pane the control
column took 384 px and left the prose 312, which is **31 ch**. The measure invariant
failed on the first run. `minmax(0,1fr) minmax(0,0.5fr)` cannot do that.

Measured, as shipped (17 px prose, `ch` measured from the resolved font rather than
assumed):

| Where | pane | measure |
|---|---:|---:|
| *before, Wide 1600×900, the same window* | *289 px* | *28.7 ch* |
| Compact, 880×900, the sheet | 489 px | **50.7 ch** |
| Medium, 1440×900, the overlay | 649 px | **67.8 ch** (capped) |
| Wide, 1600×900, analysis dock at its 460 px default | 397 px | **40.4 ch** |
| Wide, 1600×900, dock dragged to its 560 px maximum | 497 px | **51.3 ch** |
| driven container, 960 px | 958 px | **62.4 ch** — the brief's ~64 target |

**Where it cannot be reached, and why.** 45 ch of 17 px prose needs 413 px of pane, so
476 px of dock. The two in-flow docks at Wide give the analysis dock 460 px by default,
which is 40.4 ch — measured against **28.7 ch** in the same window before this change
(the pre-W2 `flex: 1 1 auto` restored over the live app, so the two numbers are the
same measurement), and a long way from W1's ~25 at a narrower dock state. Still short,
and the harness records that as a NOTE with the arithmetic rather than passing over it. **It is not fixable by a container query,
because it is not a pane-internal problem: two in-flow docks cannot give a pane 45 ch
and the stage 50 % of the screen area below roughly 1900 px of window.** That is §3 of
the plan re-derived from a different direction, and W3's 540 px workbench answers it —
a ~494 px pane, about 53 ch.

## 4. What each pane got

| Pane | `< 520 px` | `520–719 px` | `>= 720 px` |
|---|---|---|---|
| **Inspector** | stacked joint records, every column kept, labels from `JOINT_COLUMNS` | the seven-column table | the table |
| **Signal** | wrapped row head (W1's trade) | aligned columns — a 7.5 rem layer column | two-column row: *what happened* \| *who says so* |
| **Learn** | one reading column | one reading column | control beside the prose, `1fr / 0.5fr` |
| **Modules** | no dot grid (React, not CSS); `data-pane-band` published | dot grid back | W4's full graph |
| **all panes** | `dl.kv` pairs stack; panel headers wrap; 10 px padding | key beside value; 12 px padding, `--leading-body` | — |

Two of those are the W1 hand-offs, closed: the key/value grid W1 left at
`fit-content(40%) minmax(0,1fr)` with the note *"stacking the pair outright below a
threshold is a container query and belongs to W2"*, and the Signal row alignment W1 had
to give up at 14/16/14 px, which now comes back when the pane can pay for it.

Pane spacing moved from `[data-sections='one']` to `@container pane (width >= 32.5rem)`
for a reason worth recording: the container sweep caught it. `.dock-section-body`
carried 10 px of padding at Wide and 12 below it, so an architecture canvas in a pane
driven to exactly 720 px measured 672 px in one window and 668 px in another. Four
pixels — and the invariant that says a pane at a given container width renders
identically regardless of viewport was right to fail on them.

## 5. Data semantics

`data-provenance` existed on three wrappers and on none of the badges they contain, so
a test that wanted to know what a particular badge claims had to read its text.
Extended coherently:

| Attribute | Where | Why |
|---|---|---|
| `data-provenance` | `ProvenanceTag`, the mark itself | a class name is a styling hook a refactor may rename |
| `data-origin-physical` | `OriginTag` | `isPhysicallyObserved()`'s answer, as data. `false` on every origin this project can produce, permanently |
| `data-grounding="conceptual"` | lesson cards, the lesson banner, claims, source module chips | the brief's *"observed alone is insufficient"*, applied to grounding |
| `data-build-status="not-built"` | the NOT BUILT control panel and badge | the brief's `<FeaturePanel status="not-built" />`, with the visible copy kept |
| `data-2d-surface` | `code`, `graph`, `pixels` | the scroll contract's explicit opt-out; also documentation |
| `data-pane`, `data-pane-content`, `data-pane-chrome`, `data-scroll-owner` | the contract | W6's density budget needs chrome and content told apart |
| `data-pane-band`, `data-pane-width-px` | `.arch-canvas` | what W4 branches on, published before W4 needs it |

## 6. The hook, and its one consumer

`ui/use-container-width.ts` — `useContainerWidth()` over `ResizeObserver`, plus
`PANE_BANDS` and `paneWidthBand()`, which is the single table the CSS thresholds are
written against. Zero new dependencies.

The line it draws is the brief's: *"use CSS for presentation changes and React for
semantic representation changes"*. A table that becomes stacked records is the same
seven values in the same DOM — CSS. A 63-node graph that becomes a causal-path
navigator is a different artifact — React, because CSS cannot decline to mount
something, and mounting work you intend to hide is what makes responsive React
expensive.

W4 owns the three representations. The one consumer wired here is the smallest honest
member of that family: **React Flow's decorative dot grid is not in the tree in the
narrow band.** At the zoom `fitView` picks for 63 nodes in a 355 px canvas the labels
are already 3–5 px (W1 §6), and an 18 px dot lattice behind them competes with the
artifact rather than framing it. The harness asserts it is absent below 520 px and
present above, at both viewports.

One deliberate asymmetry, recorded because it will look like a bug otherwise: the CSS
container query evaluates against the pane's **content box**, and the React band is
measured on the **artifact's own box** — the canvas, about 50 px narrower. The band
therefore flips slightly later in React than in CSS. That is conservative in the safe
direction: a scoped representation in a box 50 px too big is a better failure than the
full map in one 50 px too small.

## 7. Verification

The brief asks for viewport and container sizes to be tested **independently**, and
that is the whole point of the mechanism rather than a stylistic preference.

**Static, in the stylesheet** — beside W1's type-scale block, for the same reason:

| Invariant | Result |
|---|---|
| `.pane` carries `container: pane / inline-size` | pass |
| every `@container` names the `pane` container | 9/9 |
| the thresholds are the brief's two, and only two | 32.5rem / 45rem |
| **no `font-size` inside any `@container` block** | **0** — W1's `@media` rule, for the mechanism that replaced it |

**In the browser** — each of four panes driven to nine explicit container widths, in a
1280×800 window and a 2560×1440 one. The widths are the brief's component-harness list
with the values immediately either side of both boundaries, because *"519/520 matters
more than 480/768"*; they are set on the pane element rather than by resizing a dock,
because a dock cannot reach 960 px and the point is to test the mechanism rather than
today's geometry.

| Invariant | Result |
|---|---|
| the representation changes **at** 520 px and 720 px of container | 4 panes × 9 widths × 2 windows |
| **the same pane at the same container width is identical in both windows** | **0 differences** |
| lesson prose 45–75 ch wherever the container can geometrically hold it | pass; two widths recorded as a NOTE with the arithmetic |
| ≤ 1 ordinary vertical scroller per pane, `data-2d-surface` excluded | pass |
| the published `data-pane-band` agrees with `paneWidthBand()` | pass |

Two measurements are deliberately **excluded** from the identity comparison, and both
exclusions are W1's doing rather than a loophole: the measure in `ch` and the width of
one character. The type scale is fluid *above* 1440 — 17 px prose at 1280, 18 px at
2560 — so one character is 9.16 px in one window and 9.69 in the other. The box is
identical; the number of characters in it is not, and asserting otherwise would assert
that a bigger screen may not use its width.

- `pnpm -r run test` — **948 passing**, unchanged.
- `pnpm --filter @sesame-lab/web typecheck` — clean.
- `node scripts/capture-web-screenshots.mjs` — **32 captures, 0 problems**, two NOTEs:
  W1's architecture-graph zoom debt, and the prose measure at the two dock widths §3
  names. (One intermediate run of the same code produced 31 and a third NOTE: QEMU
  did not boot inside its timeout, which is ISSUE-022's ~28 % panic rate and is
  unrelated to anything here. The next run booted on its first attempt.) Every pre-existing assertion still holds — L4's three source registers, L4's
  code-view scroll, ISSUE-20260823-023's world frame at every breakpoint and across both
  dock resizes, overlay-not-push below Wide, one open pane behind one scrollbar, and
  `wave` reachable with both docks shut.
- **Zero new dependencies.**

Roughly 89 selector lines changed of 449 — the brief's estimate was a quarter to
two-fifths, and this is a fifth, because the panes that needed the most work
(Source, Face, Lab) are W5's.

## 8. Handed on

**W3 — the workbench.** `[data-sections]` is the attribute to set: a workbench is
`one` by definition. Everything that reads it — scroll ownership, the Source pane's
two regimes, dock spacing — follows without editing a pane rule. And the arithmetic in
§3 is the number W3 needs: a 540 px workbench gives its pane about 494 px, which is
about 53 ch of prose, inside the brief's band with room to spare.

**W4 — the representations.** `useContainerWidth()` and `paneWidthBand()` are built and
asserted; `.arch-canvas` already publishes `data-pane-band` and `data-pane-width-px`.
The thresholds in `PANE_BANDS` and the thresholds in the stylesheet are the same two
numbers, checked statically, so the CSS and the React branch cannot drift apart.

**W5 — the panes this did not touch.** Face's integer-pixel zoom policy is still open:
`.oled-canvas` is `width: 100%`, so at a 377 px pane a logical pixel is 2.94 device
pixels and the SSD1306 page-grid lines fall between them. It is marked
`data-2d-surface="pixels"` and the container-width hook is the tool, but the largest
integer zoom that fits our real pane widths is 2×, which is a large visible shrink and
a policy decision rather than a bug fix. Source keeps its three regions; only their
scroll ownership changed. The Inspector's stacked records are grouping, not columns
dropped — all seven survive — but "compare two joints at a glance" is now a scroll,
and that is the trade W5 should look at.

**W6 — the invariants.** `data-grounding`, `data-build-status`, `data-provenance` on
the mark and `data-origin-physical` make the correctness assertions structural instead
of text-scraping. `data-pane-chrome` / `data-pane-content` are in place for the brief's
30 %-chrome density budget. The `@container` font-size parser is written and passing;
the reduced-motion `overrides` layer is still empty and still W6's.
