---
task: "W7 — the module-first shell"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §11
source: "docs/research/Sesame Lab_ responsive UI_UX research brief.md"
follows: docs/findings/W4-architecture-representations.md
amends: docs/findings/W3-one-workbench.md, docs/findings/U6-two-dock-shell.md
---

# W7 — one module, one panel, and the rule that could not hold

**Trigger:** the user, with W3 and W4 on screen.

> *"On ultra large screens, the modules sections are still unusable. The
> architecture diagram needs to use up at least 50% of the screen to be useful,
> with the robot in the other half. I think the commands and face tools can be
> made to be minimal on small screens and never need their own individual
> scrollbars. Make use of 'more info' popovers or screens to dive into more
> details over the key information and face that you'd want to look at while
> executing commands. Make that the right most side-panel while the larger
> content items can be maximize. The Architecture, Signals, Source and Learn
> modules should only have one active at a time."*

---

## 1. The shell, as built

```text
>= 1200 px                                              < 1200 px
+----+---------------+---------------+------------+     +----+-----------------+
|RAIL|               |               | Driving    |     |RAIL|                 |
| 64 |    ROBOT      | ONE MODULE    | Commands   |     | 64 |  ROBOT, all of  |
|Arch|               | Architecture  | Face       |     |    |  the shell      |
|Sig |               | Signal        | Selected   |     |    |                 |
|Src |               | Source        |   joint    |     |    | module + panel  |
|Lrn |               | Learn         |            |     |    | are SHEETS      |
|Lab |               | Lab           |   280 px   |     |    |                 |
+----+---------------+---------------+------------+     +----+-----------------+
| SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE     |     | the same 32 px strip |
+--------------------------------------------------+    +----------------------+
```

Eight panes became two kinds that were never the same kind:

| | what it is | how many |
|---|---|---|
| **modules** | `Architecture · Signal · Source · Learn · Lab` — large task surfaces | **exactly one active, or none** |
| **the side panel** | `Driving · Commands · Face · Selected joint` | all of them, always, above Compact |

The rail is the navigation. There is no accordion, no section navigator and no
mode switch, because there is nothing left for them to switch: the state is one
nullable id.

### One at a time is a property of the state, not a rule

`ShellState.activeModule` is `ModuleId | null` per breakpoint. **A two-open state
is not representable, so it is not reachable** — which is strictly stronger than
a rule that closes the others, because a rule is a thing something can forget to
apply. The harness asserts it the same way: it activates each of the five in
turn at every window and counts *laid-out module panes*, which is 1 every time,
and it counts accordion toggles anywhere in the document, which is 0.

**W3's derived `Control | Analyze` generalises rather than being replaced.** The
mode is `modeForState()` — the domain the active module belongs to, `control`
with none active — so `mode: 'analyze'` with the Lab up is still a state this
shell cannot represent. No second flag was added, and the mode still survives a
reload for free.

### What was deleted

**The two-dock Wide regime, the accordion, the workbench, the mode switch, the
section navigator, the icon strips and `dockWidthPx`.** W3's 1700 px boundary
went with them: it was *"two 360 px docks plus a 64 px rail still leave the
stage half the screen"*, and there are no docks. A number that survives the
deletion of its own justification is the hollow boundary this project keeps
catching, so `wide` was given a new meaning and a check to go with it — see §4.

---

## 2. §11.2's rule conflict, and the one that could not be resolved

### The two regimes, both asserted, with the app saying which

`data-stage-rule` on `.shell`, beside `data-active-module` and
`data-focus-pane`:

| value | when | floor |
|---|---|---|
| `area-50` | no module active | stage >= 50 % of the **viewport** area (§7, unchanged) |
| `content-50` | a module is active | stage >= 50 % of the **content** area — viewport minus rail, status strip and side panel |
| `focus-exempt` | W4's focus workspace | the brief's sanctioned exception |

They are not averaged. The app declares; the harness measures the declaration
against the layout, at six windows, in three states each. A harness that decided
the regime for itself would branch on the same condition the layout branches on
and could never disagree with it.

**The 50/50 split is structural rather than arithmetic.** `.content` is a flex
row holding the stage and the module column, both `flex: 1 1 0`, with
`min-width: 0` on the module and `min-width: min(480px, 100%)` on the stage. So
the rule is a fact about the box tree, and where the stage's own floor binds —
1280×800 — it binds in the safe direction: the stage keeps **52.7 %**, never
less.

### The one that cannot hold, with the arithmetic

§11.6 asks for *"Architecture at >= 1900 px gets >= 1000 px of surface"*. **That
is incompatible with the rule §11.2 resolved, and the incompatibility is
arithmetic rather than effort.** With the module column capped at half the
content area:

```text
surface  =  (innerWidth - 64 rail - 280 panel) / 2  -  25 chrome
1000 px of surface  =>  content >= 2050  =>  innerWidth >= 2394 px
```

A 1920×1080 window is a **1894 px** viewport. It has 1550 px of content, so the
module's half is 775 px and the surface is 750 px. To reach 1000 px the module
would need 69 % of the content and the stage 31 %, which is the published rule
broken — quietly, in the direction the user's other sentence points. So it is
not done, and this is the report §11.6 asked for instead.

**Two things soften it and one sharpens it.**

- 750 px clears W4's **720 px subsystem boundary**, so a 1920 monitor gets the
  subsystem graph in the ordinary layout where before it got the causal path.
- 2560×1440 reaches **1070 px** — over the 960 px full-graph boundary and over
  §11.6's 1000 — so the requirement is met from about 2394 px of viewport up.
- And the sharp part: **1000 px of width would not have made the full graph
  legible anyway.** Measured, at 2560×1440, in the ordinary layout: 1070 px of
  surface, the `full` representation, and its worst on-screen label **4.38 px**
  against an authored 14.98. `fitView` fits the SHORT side, and the ordinary
  layout's canvas is `52vh`. W4 said this in a different accent — *"width
  without height does not fix a fitted graph"* — and §11.6's number is the same
  mistake in the plan. The surface width was never the variable that decides.

---

## 3. Measured, in a real browser

Six windows, `capture-web-screenshots.mjs` phase 12. `inner` is what the browser
gives a window of that size; every box is `getBoundingClientRect` on the live
page, and the stage is the **canvas element's own rect**.

| Window | inner | content | stage | module | surface | representation | stage % of CONTENT | stage % of window |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| 880 × 900 Compact | 854 | — | full | 640 sheet | 616 | path | — | **88.8 %** |
| 1280 × 800 | 1254 | 910 | **480** | 430 | 409 | path | **52.7 %** | 36.5 % |
| 1440 × 900 | 1414 | 1070 | 535 | 535 | 510 | path | **50.0 %** | 36.3 % |
| **1760 × 1000** | 1734 | 1390 | 695 | 695 | 670 | path | **50.0 %** | 38.7 % |
| **1920 × 1080** | 1894 | 1550 | 775 | 775 | **750** | **subsystem** | **50.0 %** | 39.6 % |
| 2560 × 1440 Wide | 2534 | 2190 | 1095 | 1095 | **1070** | **full** | **50.0 %** | 42.2 % |

With **no module active** the same windows read **69.3 / 72.7 / 77.3 / 79.2 /
84.4 %** of the *window's* area, all clear of the `area-50` floor.

**Lesson prose at 1440 × 900: 506 px of 17 px text in a 534 px pane — 55.2 ch**,
measured in the shell a reader gets rather than in a pane driven to a width by a
test. W1 measured about 25 ch in the two-dock shell and W3 got 50.7 in the
workbench; one column of half the content area gets 55.2, and the brief's band
is 45–75.

### The label sizes, which are the number W4 asked for

| Where | representation | authored | **on screen** |
|---|---|---:|---:|
| 1440 × 900, 1760 × 1000 ordinary | causal path | 14.0–14.3 px | **the same** — no transform anywhere in the subtree |
| **1920 × 1080 ordinary** | **subsystem** | **14.40 px** | **14.40 px** — zoom pinned at 1 |
| 2560 × 1440 ordinary | full | 14.98 px | **4.4–9.2 px** — `fitView` on 63 nodes in a 52vh canvas, and it moves with how much is expanded |
| 1440 × 900 focus workspace | subsystem | 14.0 px | 14.0 px |

The 4.38 px row is W4's scoped debt arriving in a place W4 never reached, and it
is left in the report rather than reframed. It is also §2's argument: the full
graph is the one representation whose legibility is a function of canvas
*height*, and the ordinary layout does not have the height to give it. The
answer for a reader who wants the whole map is the focus workspace, which is one
button and which W4 measured at 12.9–15.0 px.

### 1760 × 1000, the gap W4 handed over

W4 recorded that the two-dock Wide regime held **45.0 %** of the window's area
there at its *default* dock widths — below W3's floor, unasserted because phase
12's only Wide window was 2560. **The regime is gone, 1760 × 1000 is in the
sweep by name, and both stage rules are asserted at it.** The NOTE W4 printed
every run is **deleted**, not re-worded: it described a layout that no longer
exists, and a note that goes on printing about a deleted regime is the same
failure as an assertion that goes on passing against one.

---

## 4. `wide` means something again

| | W3 | W7 |
|---|---|---|
| boundary | 1700 px | **2314 px** |
| derived from | two 360 px docks leaving the stage half the screen | `(innerWidth - 344) / 2 - 25 >= 960` |
| what it claims | a two-dock shell fits | **the ORDINARY layout holds the whole 63-node graph** |
| asserted | — | at Wide the surface is >= 960 and the pane mounts `full`; below it, neither |

`compact` keeps 1199 and gains an arithmetic of its own:
`64 rail + 280 panel + 480 stage floor + 376 module = 1200`, where 376 is the
first width above the 351 px W4 measured the causal path at and called *"legible
but cramped"*.

Above Compact the two names differ in exactly one thing — which band the
architecture reaches — and the layout is identical. That is stated rather than
hidden: a breakpoint that changes nothing about the layout is only worth keeping
if it names a fact, and this one does.

---

## 5. The side panel: zero scrollers, and how that is made true

§11.4: *"Never its own scrollbar — neither Commands nor Face. If content does
not fit, that is a content problem to solve by disclosure, not by adding a
scroller."*

**Measured: 0 scrollers and 0 px of overflow, at every one of the six windows,
with three different modules up.** Three mechanisms, in the order they take
effect:

1. `overflow: hidden` on `.side-panel-inner`, so a scrollbar cannot appear;
2. cards **fold** in a fixed priority order — `Selected joint`, then `Face` —
   until the content fits, measured after every commit rather than keyed to a
   height breakpoint;
3. and the harness asserts `scrollHeight <= clientHeight` **as well as**
   `scrollers.length === 0`, because `overflow: hidden` turns "it scrolls" into
   "it is cut", which is worse rather than better, and a scroller count alone
   would read zero while a provenance badge sat below the fold.

**Commands and Driving cannot fold at any height.** Commands because it is the
surface the panel exists to hold and because `[data-command="wave"]` is the
button four harness phases press; Driving because §11.4 forbids a correctness
surface from living behind a disclosure. If those two alone stopped fitting the
panel would overflow and the run would fail on it — which is the intended
failure, because that is a content problem and the answer is shorter content.

What folds, per window:

| Window | panel height | folded | scrollers | overflow |
|---|---:|---|---:|---:|
| 880 × 900 sheet | 741 px | Selected joint | 0 | 0 px |
| 1280 × 800 | 641 px | Face, Selected joint | 0 | 0 px |
| 1440 × 900 | 741 px | Selected joint | 0 | 0 px |
| 1760 × 1000 | 841 px | — | 0 | 0 px |
| 1920 × 1080 | 921 px | — | 0 | 0 px |
| 2560 × 1440 | 1281 px | — | 0 | 0 px |

So the two surfaces the user named — Commands and the Face — are on the panel at
every window from 1440 × 900 up, and Commands is on it at every window full
stop. The joint glance is the one that folds on a laptop, and it folds to a
header carrying the selected joint and the provenance of its reading.

### The fold had to be reversible, and the first version was not

The first version folded one card per commit and never unfolded. During mount
the inner box has no height, every card "overflows", and the panel arrived at a
screen with room for four cards showing one. The fix is that each card's cost is
**measured while it is open** and remembered, so a fold can be undone when the
slack provably exceeds it — and the unfold tries the most recently folded first
and falls through to a lower-priority card that does fit, because an empty gap
on the panel teaches nobody anything.

### And the elastic card had to go, for a reason worth recording

The Face card was `flex: 0 1 auto` on the theory that a 128×64 panel is the one
surface that can give up height without hiding a word. On screen it was crushed
to **10 px** — and, worse, **the crushing did not register**: a
`container-type: inline-size` box does not contribute its overflow to an
ancestor's scrollable overflow, so `overflowPx` went on reading 0 while the whole
card was invisible. A safety valve the assertion cannot see is worse than none.
Folding is visible in the DOM, in `data-folded`, and in the card's own summary,
so folding is the only mechanism.

---

## 6. What may not be demoted into a popover

§11.4, and it is exactly the thing a "minimal panel" brief invites somebody to
tidy away. Asserted by name at every window, **with every "more info" screen
shut**, and each reading carries `insidePopover` — because the failure this list
exists for is not an element disappearing, it is an element still existing
somewhere nobody will meet it.

| On the panel, always | where it is |
|---|---|
| the driving **provenance** badge | `[data-testid="panel-provenance"] .prov` |
| the driving **origin, in full**, with its board | `#origin-banner [data-origin-kind]` |
| `measurementVerdict()`'s **claim line** | `#measurement-verdict` |
| **PHYSICAL HARDWARE: NONE**, read off the counter | `[data-testid="panel-physical-hardware"]` |
| the OLED's **pixel provenance** | the Face card's header summary |
| the **two zero-frame faces**, marked | `[data-zero-frame-faces]`, on the same summary |
| the **selected joint** and the provenance of its reading | the glance card's summary |

Three of those ride on a card's *header summary* rather than in its body, which
is what keeps them visible when the panel folds the card away. The
`measuredDeg = null` row and `HAS_JOINT_POSITION_FEEDBACK` stayed in the glance
card's body for the same reason the pane's own header comment gives: leaving it
to the popover would teach a reader that the robot has feedback it does not have.

**What did move, and why that is allowed.** A popover may *expand* a correctness
surface. So the panel carries the claim and the screen carries the paragraph:

| screen | what it adds |
|---|---|
| **Driving** | the backend switch, `PROVENANCE_MEANING`, the full four-line verdict, the provenance and origin count rows, and the emulator's qualifiers |
| **Commands** | the whole 20-command vocabulary and the ten-face shortlist |
| **Face** | the OLED at **4×**, the GDDRAM read-out, the payload, and the two full "these pixels did not come from the emulator" paragraphs |
| **Selected joint** | the seven-column table for all eight joints, the per-joint slider and the asset facts |

`measurementVerdict()` was split into `measurementHeadline()` and
`measurementDetail()`, both computed from the same `isPhysicallyObserved()` call,
so the short form on the panel and the long form in the screen cannot say
different things.

The screens are native `<dialog>`s opened with `showModal()` — focus
containment, `Esc` and an inert backdrop from the platform, **zero new
dependencies** — rendered as siblings of the shell's columns rather than inside
the panel, which is what keeps the panel's scroller inventory a statement about
the panel.

---

## 7. Two defects the module-first layout exposed

Both were invisible before because no arrangement in this project had ever put
these panes at these widths.

**1. A zero width is "not laid out", never "narrow".** `display: none` on an
ancestor makes `ResizeObserver` report 0×0, and `useContainerWidth` was treating
that as a measurement. So every module switch unmounted and remounted React Flow
— the wasted mount/unmount work W4 chose React-side switching to avoid — and the
remount is where the harness caught the **subsystem graph drawn at 0.929** in a
window where its floor is 1: 14.4 px edge labels at **13.38 px** on screen. The
hook keeps the last real width now, and a pane that comes back comes back as the
artifact it was.

**2. The subsystem's zoom floor was requested rather than enforced.**
`minZoom: 1` in `fitViewOptions` and `minZoom={1}` on the component are both
true and neither was sufficient. The reframe now clamps after its own `fitView`,
`archGraph()` **publishes `viewportZoom`**, and the harness asserts it directly
rather than inferring it from how big some text happened to measure. That
assertion is what turns *"the labels came out big enough"* into *"the property
this representation is built on holds"*.

A third thing, found by looking rather than measuring: **the module column's own
chrome was costing the architecture a whole band.** A frame border, a column
body's padding, the pane's padding *and* a `.panel` inside all of it came to
**71 px**, and at 71 px a 1920 monitor got 691 px of surface and the causal path
whatever the side panel was set to. Flattening the panel-inside-a-panel took it
to **25 px** and bought the subsystem graph. It is also the right thing
visually — it is what removed the `ARCHITECTURE` / `ARCHITECTURE` duplication W3
handed to W5 as *"the clearest single thing left on the laptop screen"*. Both
rules live in `@layer panes` and say so: `@layer shell` loses to
`@layer components`, and the first version of both sat beside the rest of the
column's geometry, looked right, and did nothing at all — which is the trap W4
recorded and this workstream walked into anyway.

---

## 8. What the two prior workstreams asked to keep, and where it went

| | kept as |
|---|---|
| **W1** type floor | 163 `font-size` declarations, 0 literals, 0 inside `@media`, 0 inside `@container`; no visible run below 14 px at any of the six windows |
| **W2** pane contract | every module pane and every panel card is `<section class="pane" data-pane>` with `.pane__header h2` and `.pane__content{min-inline-size:0}` |
| **W2** `[data-sections='one']` | the module column is `one` **by definition**; every pane rule keyed on it went on working with **zero pane-rule edits**, for the second workstream running |
| **W2** container/media split | 9 `@container` rules, all naming `pane`, still exactly two thresholds; the sweep still drives four panes to eleven widths in two windows with **0 viewport-dependent differences** |
| **W2** one scroller per pane | the module column has exactly one, `[module-body]`; the side panel has **zero** |
| **W3** derived mode | `modeForState()`, from one field instead of a list |
| **W3** the inverse assertion | *"the stage must lose more than 300 px"* — adapted, not deleted: **activating a module** is what opens now, and it takes half the content area |
| **W3** environment line | unchanged, including `display: inline` with real spaces; the panel's `PHYSICAL HARDWARE` line is built the same way for the same reason |
| **W4** three representations | React chooses, CSS does not hide; `data-zoom-surface` is still the full graph's alone |
| **W4** cross-highlight | see below |
| **W4** focus workspace | unchanged in kind, and now asserted to close ITSELF when its module leaves the screen |
| **L4 / L6 / V8** | three source registers, the code-view scroll, the lesson node clicks, the drawn quaternion — all still asserted; every pane is still `display: none` rather than unmounted, for the four reasons W3 enumerated |
| **ISSUE-20260823-023** | every breakpoint, plus **across a module clear/activate and a module switch** — the path W7 adds |

### The cross-highlight is a stronger assertion now, not a weaker one

V8's argument for splitting the workbench was that the graph and the trace have
to be visible *at once*. §11.3 forbids that on purpose. So the harness asserts
the thing that argument was really about: **the selection survives the module
switch.** `L3` is selected in the architecture module, the reader switches to
Signal, and its `servo.target` and `pwm.output` rows are already lit when they
arrive — which is a property of there being one `SelectionState` rather than of
two panes happening to share a screen.

The §5.1 badge moved with it. A selection that lands in a module the reader is
not looking at is announced on that module's **rail button** — `Arch ● joint.R4`
— which is the one zone that is always on screen. It still carries
`data-dock-badge`, so the debug hook still finds it with one document-wide
lookup.

### The seven-column joint table is still swept

It moved into the "more info" screen, and the pane it used to live in became a
280 px glance card — so without care W2's table-vs-stacked-records container
query would have stopped being exercised anywhere. `JointInspector` renders
inside a `<div class="pane" data-pane="joints">` and the sweep opens the screen
to drive it. The wrapper is a wrapper rather than the class on `.panel` for a
measured reason: `.panel` carries 12 px of padding, a container query evaluates
against the content box, and a pane driven to 522 px would have queried 496 and
landed on the wrong side of its own 520 px threshold. **Asserting a boundary
means standing on it.**

---

## 9. Verification

- `pnpm -r run test` — **985 passing**, unchanged in total and substantially
  rewritten in `shell.test.ts` (47 tests). The new ones worth naming: the two
  stage regimes as a function; the breakpoint arithmetic at both edges, each
  against the constants it is derived from; **the geometry checked against what
  the browser measured at five windows**, which is the formula against the
  layout rather than a restatement of itself; that a `v2` two-dock record is
  discarded whole and removed; and that a stored record cannot hide the panel
  above Compact.
- `pnpm run typecheck` / `pnpm run lint` — clean.
- `node scripts/capture-web-screenshots.mjs` — **37 captures, 0 problems**, full
  run with QEMU. Was 35; the two new ones are the sixth window (1920 × 1080,
  which is where the subsystem graph first appears in the ordinary layout) and
  `w7-shell-no-module.png` — the OTHER stage regime, photographed, because
  `area-50` is half of §11.2's resolution and every other capture in the sweep
  is of the half with a module up. A rule with no picture of it is a rule a
  reader has to take on trust.

  `u5-shell-laptop-wide.png` was **deleted**: it was the 1600 × 1000 window W3
  added as "the top of the workbench band", and there is no workbench band. A
  picture of a layout that no longer exists is the same hazard as a note about
  one.
- **Zero new dependencies.**

What phase 12 asserts that it did not before: both stage regimes with the
declaration checked against the measurement; the content box against
`innerWidth - rail - panel`; one active module for every module at every window;
zero accordion toggles document-wide; the side panel's zero scrollers **and**
zero overflow; the named correctness inventory with every screen shut; the
Commands card never folded and its `wave` button a 36 px target; the "more info"
screen opening from a hit-tested control and holding all eight joints; the
architecture's own box against W4's bands in the ORDINARY layout, with the
subsystem's zoom floor read off the published transform; and the active module
and the derived mode surviving a real reload.

Every pre-existing assertion still holds, including the ones that had to be
re-pointed: L4's three source registers and its refusal check, L6's lesson node
clicks, V8's nine collapsed nodes and its `pwm.output` row printing ticks and µs
and no channel number, the QEMU leg's `origin.kind="emulator"` with
`isPhysicallyObserved()` false, W1's floor and no-truncation rules, W2's 0
viewport-dependent pane differences, lesson 2 end to end at Medium, and the
Lab's byte-exact C++ round trip at Compact.

---

## 10. What §11 got wrong once it was on screen

- **§11.6's "Architecture at >= 1900 px gets >= 1000 px of surface" cannot hold
  with §11.2's own rule.** The arithmetic is in §2: 1000 px of surface needs
  2394 px of viewport under a 50 %-of-content stage floor. Reported rather than
  averaged away. And the sharper half: 1000 px would not have made the fitted
  63-node graph legible either — the ordinary layout's constraint is canvas
  HEIGHT, which W4 already knew and §11.6 forgot.
- **§11.4's "280–320 px" is a margin decision, not a threshold one.** At the
  25 px of chrome this shell ended up with, anything in that band clears the
  720 px subsystem boundary at 1920. 280 was chosen because every pixel of panel
  is half a pixel of architecture surface, and it moves the full-graph boundary
  from 2354 px of viewport to 2314. **What actually decided the band was the
  module column's chrome**, which no part of §11 mentions.
- **§11.4's "collapses to the rail's icon strip below the workbench regime"**
  describes a strip that W7 deletes. At Compact the panel is a full sheet opened
  from a `Panel` button on the rail — the rail is 64 px and already carries five
  module buttons, so a second strip beside it would be two navigations.
- **§11.1's diagram omits the trust card.** It lists "Commands, Face, glance
  info"; §11.4 then forbids demoting provenance into a popover, which means a
  fourth card that the diagram does not have. It is drawn first and it cannot
  fold.
- **Lab in the exclusive set is right, and §11.3 asked to be told if it were
  not.** It is not wrong: at 535 px of column at 1440×900 the pose table has
  room it never had in a 400 px dock, and the C++ export still round-trips
  byte-for-byte at Compact.
- **The `Modules` / `Architecture` naming, finally.** The module is labelled
  `Architecture` on its own title and `Arch` on the rail — 60 px of rail column
  at the 14 px floor is about six characters, and `Architecture` would have
  broken mid-word in the one zone this product promises never to hide anything
  in. The id stays `modules`: renaming it would touch storage, the debug hook
  and eight phases of assertions for a label.

---

## 11. Handed on

**W4 or W5 — the subsystem's FRAME.** The representation is right and the type
is right; the picture is not. At 1920×1080 the scoped Movement neighbourhood is
taller than the 52vh canvas at zoom 1, so the frame falls back to the focus and
its chain and leaves most of a 750×490 box empty above the joints row. W7
measured the whole neighbourhood's bounding box against the canvas and frames it
whole when it fits — which it does not at any window this shell reaches. Framing
a fitted graph in a box that is wide and short is an unsolved problem in this
pane and it is the same one as the 4.38 px below.

**W5 — the panes.** The Modules pane's `N expanded` badge is gone with the
collapsed headers, so W4's §10.2 is closed by deletion rather than by a fix. The
duplicated pane title is closed too, and by the arithmetic in §7 rather than as
a styling preference. What is left for W5 is inside the modules: the Signal
row and the Source pane at the much larger widths the module column gives them,
and the OLED's integer-zoom policy everywhere except the side panel, which takes
2× here because a fixed-width panel is the first arrangement where an integer
zoom is simply available.

**W6 — the invariants.** Published as data and assertable against structure:
`data-stage-rule` (three values now), `data-active-module`, `data-panel-card`,
`data-folded`, `data-panel-summary`, `data-panel-more`, `data-popover`,
`data-zero-frame-faces`, `data-module-nav`, and `archGraph().viewportZoom`. The
200 % zoom and text-spacing gates are still open; note that the side panel is
the surface most exposed to both, because it is the one box in this shell that
may not grow a scroller, and its fold logic is measured rather than keyed to a
threshold — so it should degrade rather than break.

**Whoever owns the full graph.** 4.4–9.2 px at 1070 px of surface in the ordinary
layout at 2560×1440 is the number to beat, and width is not the lever. The
canvas is `52vh`; the focus workspace gives it `62vh` and a much narrower stage
and reaches 12.9–15.0 px. Either the ordinary layout gives the full graph real
height, or `full` should not be the representation the ordinary layout mounts at
all and the band should be about the CANVAS rather than about the surface.
