---
task: "W6 — the 28 invariants, and the eleven nothing was asserting"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs, docs/findings
plan: docs/plans/phase-4-ui-ux-revision.md §4 W6
source: >
  docs/research/Sesame Lab_ responsive UI_UX research brief.md —
  "The machine-checkable contract should be strict" (the 28-row table),
  "Quality gates for cluttered and clumsy",
  "Focus and targets should exceed bare-minimum accessibility",
  "Motion should explain state change rather than make the UI feel lively",
  "Provenance needs redundant text, not clever iconography"
follows: docs/findings/W5-hard-panes.md
---

# W6 — the last workstream, and the four things the palette was hiding

**The audit came first, and it changed the shape of the work.** Seventeen of the
brief's twenty-eight invariants were already asserted, each by the workstream
that built the thing it is about. What was left was the set no pane owns:
contrast, target size, keyboard reachability, focus, reduced motion, page-level
horizontal overflow, and the two release gates. Those are in a new **phase 13**.

What that phase found on the first run was not a set of gaps in the harness. It
was **six defects in the app**, four of them in code a screenshot review had
passed a dozen times, and four of the six in the same place: **`opacity`, and
one token**.

---

## 1. The audit — what was already covered

Repeated here because "we asserted it" is a claim like any other, and the point
of the audit was to stop W6 re-implementing seventeen checks that exist.

| Invariant | Already asserted by |
|---|---|
| Meaningful text floor (14 px) | phase 12, six windows, computed styles |
| 1440×900 role sizes (16/15/17) | phase 12, plus the static token check |
| Token discipline — no `font-size` literals | the static stylesheet scan, W1 |
| ≤1 vertical scroll owner per pane | phase 12, narrowed by W5 |
| No nested vertical scrollers | phase 12's scroller walk |
| Semantic horizontal scroll (`[data-2d-surface]`) | phase 12, and W5's Lab sweep |
| Provenance rendered in words | phases 1–8; `CORRECTNESS_SELECTORS` |
| Origin rendered, never bare "observed" | phase 12, `data-origin-kind` |
| No phantom hardware / `PHYSICAL HARDWARE: NONE` | phases 6 and 12 |
| Every `pwm.output` is `inferred` | phase 7 |
| `CONCEPTUAL` labels | phase 10 |
| `NOT BUILT` labels | phase 10 |
| Correctness text never truncated | phase 12's `typeScan.truncated` |
| Lesson measure 45–75 ch | phase 12, with W1's recorded exception |
| Modules narrow / intermediate modes | W4, and phase 12's per-window sweep |
| One laptop workbench | W3 and W7, phase 12 |
| Robot not occluded / stage area | W3's area rule, phase 12 |

**Eleven were open**, and every one of them is now measured in a browser:
page-level horizontal overflow, control targets at both tiers, the WCAG 24 px
floor, contrast for text and for control boundaries, keyboard reachability,
visible and unobscured focus, reduced motion, dragging alternatives, the 200 %
zoom gate, the text-spacing gate, and the colour-redundancy half of provenance.

---

## 2. Contrast — one token, and three uses of `opacity`

### 2.1 `--muted` failed everywhere it was used

`#6b7688` on the app's three surfaces:

| background | ratio | needs |
|---|---:|---:|
| `--panel-2` `#1b212b` | **3.52** | 4.5 |
| `--panel` `#151a22` | **3.80** | 4.5 |
| the pane card `#101a` region | **4.02** | 4.5 |
| the status strip `#0f1319` | **4.06** | 4.5 |

That is not a decorative token. The runs it failed on include
**`PHYSICAL HARDWARE:`**, **`SYSTEM:`**, every **`origin not stated`** badge,
every **trace witness** and its `who says so` key, the Signal step numbers, the
Inspector's `never`/`—` cells and the lesson card progress counts.

`--muted: #838da0` is the smallest lift that clears 4.5:1 on every background it
is measured against — worst case **4.84** on `--panel-2`, 5.70 on the page. The
palette is otherwise untouched, which keeps the plan's *"no repaint"* rule: the
brief endorsed these colours and one of them was simply wrong.

### 2.2 `opacity: 0.45` on the source pane was the worst thing in the app

`.src-line` dimmed every line outside the selected symbol. Group opacity
composites the **whole subtree** — text included — onto the backdrop, so the
measured ratios on the pane whose entire purpose is reading 429 lines of real
C++ were:

| run | ratio | count on screen |
|---|---:|---:|
| `.src-num` | **1.66** | 9 |
| `.cpp-comment` | **1.92** | 3 |
| `.cpp-keyword` | **2.43** | 47 |
| `.cpp-string` | **2.53** | 30 |
| `.cpp-type` | **2.73** | 53 |
| `.cpp-number` | **3.12** | 71 |
| `.cpp-plain` | **3.44** | 238 |

There is no opacity that fixes this: even at `1.0` the palette's own floor was
3.59:1. So the de-emphasis is **by addition** now — every line paints at full
strength and the *selected symbol* gets a background (`#16202c`) — and
`.cpp-comment` moved from `#6b8a63` to `#7ba070`, the one colour that still
failed (4.28:1) on the `did-run` green.

The intent the old rule expressed — *"present, readable, clearly not the
subject"* — is kept. What changed is which half of the contrast does the work.

### 2.3 Two more alpha dims, both on live controls

- **`.prov-zero { opacity: 0.35 }`** put `--observed` green on a panel at about
  **1.6:1**. The row it dims most often is **`physical-robot 0`** — the single
  fact this project most wants a reader to be able to read. It is `--muted`
  now, which is 4.84:1 and still reads as "nothing here".
- **`.lesson-card.is-locked { opacity: 0.55 }`** measured **1.93:1** on the
  order number, **2.52:1** on the `outline` badge and **2.79:1** on
  `conceptual`, on **18 of the 19 cards**. A locked card is a *live button* —
  the copy says *"locked — read it, but finish meet-sesame first"* — so WCAG's
  inactive-component exemption never covered it. It is a dashed border and a
  `--dim` body now, and `cursor: not-allowed` went with the opacity because it
  was describing a card you can in fact click.

`:disabled` controls keep their alpha and the check exempts them by name, which
is the exemption the criterion actually grants.

### 2.4 Result

**0 contrast failures across five modules and the Inspector screen, at both
1440×900 and 880×900** — **1,692 and 1,462 runs of text measured**, worst
measured ratio **4.82:1** (`· 429`, the Source tab's line count) — against
4.5:1 for normal text and 3:1 for large text. `overBackgroundImage: 0`, so
nothing was skipped as incomputable.

Non-text contrast (1.4.11) is asserted separately and **only where the boundary
is required to identify the control**: form controls, whose box is the whole
affordance, and any control with no visible text. The first version ignored the
word "required", measured every button's border, and reported **214 failures at
1440×900** — almost all of them rail buttons at 1.4:1, each carrying a 20 px
glyph and a word both well above 4.5:1. A gate that cries wolf 214 times is a
gate somebody deletes, so the scope is the criterion's own.

**One more thing the check was hiding from itself.** It treated any
`background-image` as "cannot compute" and skipped the element and everything
under it — **351 elements at 1440×900**, because `.trace-step` paints the
Signal ladder's spine with `linear-gradient(--line, --line)` at
`background-size: 2px 100%; no-repeat`. A two-pixel rule in the gutter had
exempted every witness paragraph, every provenance badge and every lane in the
pane the check most needs to cover. A no-repeat image smaller than its box is a
stripe now and does not count; anything that tiles or covers still counts as
unknown, and unknown is reported rather than passed.

---

## 3. Target sizes — hit-tested, not measured

`.info-dot` is why the check is a hit test. It paints a 20 px circle and carries
its 36 px target on an absolutely positioned `::after` that contributes nothing
to the button's rect. A check written against `getBoundingClientRect` would have
failed a control that is correct — and, far worse, would have passed any control
that grew its rect without growing what a pointer can land on.

So the target is found by bisecting outward from the centre with
`document.elementFromPoint` in each of four directions. Measured before:

| control | before | after |
|---|---|---|
| `.status-cmd` — the four quick commands | 57.7 × **27.2** | 57.7 × **36** |
| `.source-tab` | 252 × **32.8** | 252 × **36** |
| `.source-outline-row` × 25 | 251 × **28.8** | 251 × **36** |
| `<summary>` × 6 | 510 × **24.8** | 510 × **36** |
| `.arch-branch` | **32.1** × 36 | **36** × 36 |

After: **182 targets hit-tested at 1440×900 and 65 at 880×900, 0 under the
36 px policy and 0 under WCAG's 24 px floor.** 123 and 70 more were reported
`unhittable` — scrolled out of their own container at the moment of the probe —
and are counted rather than passed, because a target nothing can hit is not a
large target. 45 at 880×900 were skipped as `inert` behind a Compact sheet.

Every one cleared WCAG's 24 × 24 floor and none cleared the project's 36. **The
status strip grew from 32 px to 36 px** to hold the quick commands rather than
clipping them, and that is a deliberate change to W3's geometry — it is
`overflow: hidden`, so a 36 px button in a 32 px row would have reported a 36 px
rect and painted 32. It costs the stage 4 px of height; measured after, at
1440×900 the canvas is **535 × 775 = 50.0 % of the content area and 36.3 % of
the window**, and both stage rules still hold at every one of the six windows.

The coarse-pointer tier is a media query, so it is asserted by telling a real
browser it has a finger: under `Emulation.setEmulatedMedia` with
`pointer: coarse`, the named primary controls are ≥ 44 × 44 and the status strip
grows to 52 px so a 44 px button is not painted into a 36 px row.

---

## 4. Keyboard — two families of clicks a keyboard could not make

A scan for `cursor: pointer` on elements that are neither focusable, nor contain
something focusable, nor sit inside something focusable found **exactly two
families in the whole app**, and both mattered:

1. **`.trace-row`** — 36 `<li onClick>` rows in Signal. Clicking a lane is how
   the ladder drives the other three panes; phase 8 calls that cross-linking the
   point of the feature.
2. **`<tr onClick>`** in the Inspector — the eight joints.

Both are operable now: the trace lane is `role="button"`, `tabIndex={0}`,
`aria-pressed`, Enter/Space (`preventDefault` on Space, so choosing a row does
not scroll it out from under the reader); the joint row gains a `.joint-pick`
button **inside its identity cell** rather than a tabindex on the row, because
the row is `role="row"` in a `role="table"` and making rows focusable would have
been an ARIA grid rather than a table with a control in it.

**And one thing the walk found that no one had looked for.** At Compact the
module and the side panel are sheets, and the scrim that closes them is
`position: absolute; inset: 0` — so it covers the 64 px rail. That is the
intent. What it was not doing was saying so to a keyboard: all five module
buttons, the three backend buttons and the panel toggle were focusable and
**entirely hidden behind the scrim**, which is WCAG 2.4.11 in its plainest
form. The rail is `inert` while a sheet covers it now, which is the correct
expression of a state the layout already had, and the way out of a sheet stays
keyboard-reachable — the module's close button and the scrim itself are inside
the sheet's own subtree.

That fix then broke the check that found it, which is worth saying: the
enumeration went on counting the inert rail buttons as focusables the walk must
reach, and the run reported nine unreachable controls the browser was correctly
refusing to focus. The scans skip `[inert]` subtrees now — enumeration, target
sizes and the pointer-only sweep alike — and the count of what was skipped is in
the report, so the exemption is a number rather than a silence.

The rest was already sound, and the tab walk says so rather than assuming it:
**75 focusable elements at 1440×900 and 41 at 880×900 in the Signal module,
every one reached by a real Tab key: 0 unreached, 0 without a focus indicator,
0 rings below 3:1, 0 focused elements entirely obscured, 0 pointer-only
clickables and 8 keyboard joint pickers, at both windows.** Nothing in the stylesheet had ever written
`outline: none` — but the ring being painted was the *browser's default*, which
is a different colour in every Chromium theme and is not something this project
can assert. There is a `--focus` token and a zero-specificity `:focus-visible`
rule now, and the harness measures the ring's contrast off the focused element
rather than trusting the rule exists.

`:focus-visible` is a keyboard-modality heuristic, so the walk uses
`Input.dispatchKeyEvent` rather than `el.focus()`. A ring proven by a scripted
focus is not proof that a reader tabbing through the page sees one.

---

## 5. Reduced motion — none of it was CSS

There is not one `transition:` or `@keyframes` in 5,800 lines of stylesheet.
That is not compliance; it is a red herring. The motion in this app is:

| motion | owner | how it is disabled |
|---|---|---|
| graph reframe | React Flow interpolates the viewport transform in JS | `duration: 0` |
| camera glide | OrbitControls integrates inertia in `useFrame` | `enableDamping = false` |
| third-party CSS | `@xyflow/react`'s stylesheet in the `reset` layer | the `@media` backstop |

`ui/prefers-reduced-motion.ts` reads the query live — a reader who turns the
preference on mid-session must not have to reload — and hands the same answer to
both. The CSS block in `@layer overrides` fills the layer W2 declared empty and
reserved for exactly this.

**Measured, both legs, because a reduced-motion check that never saw motion is
worth nothing:**

| | motion allowed | `reduce` |
|---|---:|---:|
| distinct viewport transforms across one reframe | **3** | **2** (and it still moved) |
| camera travel between 60 ms and 560 ms after pointer-up | **18.8 mm** | **0.000 mm** |

The first number is the discriminator rather than "did it move", because both
legs *must* move: the reader asked for less motion, not for a graph that ignores
them. Under `reduce` the transform takes exactly one step; with motion it is
interpolated across three to six frames. On an earlier trial with the workspace
toggle the counts were 6 and 2.

**The robot's own articulation is not touched.** A joint rotating 90° → 135° is
the observable the product exists to show — the brief's motion table says
*"whatever accurately communicates the simulated motion"* — so what is disabled
is motion that decorates a state change somebody already made.

---

## 6. The 3D canvas — a limitation, stated

The judgement the task asked for. **Joint selection now has a full non-pointer
equivalent** and did not before: the Inspector's eight-row list was
`<tr onClick>`, so between the WebGL mesh and that table there was no keyboard
path to selecting a joint at all. §4 fixes it, and the harness asserts eight
`[data-joint-pick]` buttons on the Inspector screen — a check that would fail
the moment somebody replaced them with rows again.

**Camera orbit remains pointer-only, and that is recorded rather than papered
over.** WCAG 2.5.7 asks for an alternative *where dragging is not essential*;
for a 3D orbit the drag **is** the interaction, and there is no scalar the app
could expose that would not be a worse version of the same thing. What it would
take to close it honestly: `OrbitControls.listenToKeyEvents(window)` plus a
declared focus target on the canvas and a set of camera presets ("front",
"three-quarter", "from above") that a keyboard can reach — roughly the shape of
the OLED zoom ladder, applied to the camera. **That is a feature, not a
gate**, and W6 does not invent it at the end of a workstream.

The canvas is also not `tabindex`-able in a useful way: focusing it would offer
a reader a keyboard focus with nothing to operate, which is worse than an
honest absence.

---

## 7. Provenance without colour

The brief's position is *"redundant text, not clever iconography"*, and the
verification is in two halves:

- **Every `[data-provenance]` renders its own value as a word.** 59 badges on
  one Signal screen, **0 without the word**. `ProvenanceTag` renders `{value}` and
  `OriginTag` renders `describeOrigin()`, so the text is the category itself
  rather than a paraphrase of it — the meaning survives a grayscale render, a
  colour-blind reader and forced-colors intact, because the hue was never
  carrying it.
- **Nothing inside a provenance datum is distinguished by hue alone.** 0
  elements painted in `--observed`, `--simulated` or `--inferred` whose datum
  does not name the category in text.

**One thing was found and fixed rather than exempted.** The rail's connection
lamp was a `●` in `--observed` green with no adjacent word — the same hue as the
provenance category, meaning something else entirely. That is the brief's own
warning (*"do not encode 'physical' as an inactive green/red lamp that a child
might interpret as a connection indicator"*) read from the other side. It
carries a distinct **glyph per state** now — `●` connected, `◌` connecting, `○`
idle/closed, `✕` error — and the status line under the robot spells the state
out in a word beside its own dot, which is `aria-hidden` because the word is
right there.

---

## 8. The two release gates

### 8.1 200 % page zoom

Expressed the only way a headless browser can be honest about it: **half the CSS
pixels**. At 200 % zoom on a 1440×900 screen every CSS pixel is two device
pixels, so the page gets 720×450 CSS px and every media query sees 720. A
720×450 window *is* that. (`Emulation.setPageScaleFactor` is the other
candidate and is the wrong one — it is pinch zoom, it does not change the layout
viewport, and a layout that fails reflow sails through it.)

Swept across five modules: **0 correctness surfaces truncated, 0 collapsed, 0
below the 14 px floor, 0 undeclared horizontal overflow, 0 contrast failures,
and every witness paragraph whole.** The brief's own flow — open Signal, send
wave, read the complete witness chain — is what the witness count measures.

### 8.2 WCAG 1.4.12 text spacing

The four overrides forced with `!important` on `*`, which is how a user
stylesheet behaves: line-height 1.5, letter-spacing 0.12em, word-spacing
0.16em, 2em after every paragraph. **The gate asserts the overrides took**
(computed `line-height` 24 px on a 16 px body, letter-spacing 1.92 px,
word-spacing 2.56 px) before it asserts anything else, because a gate that
silently failed to apply its own stylesheet would pass every time.

Result: **0 truncated, 0 collapsed, 0 undeclared horizontal overflow** across
the same five modules.

---

## 9. Two more defects the invariants caught

### 9.1 A lesson card that pushed its module sideways

`.lesson-card` was `grid-template-columns: 22px 1fr auto`. A lesson carrying
both `conceptual` and `outline` sized the badge column to its max-content and
pushed the card **14 px past the module body**, making `.module-body` an
**undeclared horizontal scroller — 551 px of `scrollWidth` in a 534 px box, on
the Learn module, at every window**.

It is the same defect W5 found on `.lab-body` with the Pose table, in a
different pane, and it is why the page-overflow invariant is now read on **every
module's pane** rather than only the Lab's. `minmax(0, …)` on both flexible
tracks, and the badges wrap — which is the brief's own answer for this case:
*"CSS: badges wrap to a second line."*

### 9.2 And one W6 caused, found by W7's own assertion

Growing the status strip by 4 px shortened everything above it by 4 px, and
W7's `panel.overflowPx <= 1` caught the panel at **2 px over** on three of the
five modules at 1280×800. `.side-panel-inner` gives it back out of its own
chrome — no block padding, 2 px gaps instead of 4 — because the cards carry
their own padding and borders.

**Measured at both ends, and the residual is stated.** In a state neither the
harness nor W5 happened to visit — 1280×800, the simulator, one `wave` in the
trace, which grows the trust card by about 19 px — the same panel is:

| | strip | inner padding | gaps | over its box |
|---|---:|---:|---:|---:|
| pre-W6 | 32 px | 4 px | 4 px | **14 px** |
| now | 36 px | 0 | 2 px | **8 px** |

That residual is the shape W5 gave the panel — two `0 0 auto` cards that cannot
shrink above two that can — and it belongs to whoever revisits the panel. What
W6 owed was not making it worse; what it did was take four pixels for a target
and give six back.

---

## 10. Assertions that had to fail first

Five, and two of them were checks whose **first version could not have failed**:

1. **Contrast** — `--muted` at 3.52:1, on `PHYSICAL HARDWARE:`, on `SYSTEM:`
   and on every `origin not stated` badge. 8–26 failing runs per module before
   (26 in Source, 16 in Signal, 15 in Learn, 14 in Architecture, 8 in the Lab),
   0 after.
2. **The contrast check's own arithmetic.** The first version composited
   `opacity` as one more alpha on the *background* and reported **4.21:1** for a
   `.src-num` a reader sees at **1.66:1**. Group opacity composites the whole
   subtree, text included. Modelling it the way the compositor does turned 14
   failures into 26 and surfaced the worst of them — twelve runs the wrong
   arithmetic was blind to, all in the Source pane.
3. **Target size, hit-tested.** `.status-cmd` 27.2 px, `.source-tab` 32.8,
   `.source-outline-row` 28.8, `<summary>` 24.8, `.arch-branch` 32.1 wide.
4. **Reduced motion.** On the leg that allows motion the camera glides
   **18.8 mm** between 60 ms and 560 ms after the pointer is released (41.9 mm
   on an earlier 1440×900 trial) and the graph reframe takes 3 distinct viewport
   transforms; on the `reduce` leg, **0.000 mm** and 2. Both legs are asserted:
   the allowing one must SEE motion, or the reduced one is measuring nothing.
5. **The pointer-only scan.** 417 elements in Signal and 8 in the Inspector
   before, 0 after — the only ways to select a trace row or a joint.

And six traps the checks themselves had to be rescued from — five of them found
by running the harness rather than by reading it:

- **The zoom gate's first run reported 1,003 "collapsed" correctness surfaces**
  and every one was a false positive: the shell keeps inactive panes mounted
  under `[hidden]` and a closed `<details>` is `content-visibility: hidden`.
  Both compute `display: block` with a zero box. The fix is
  `checkVisibility()`, **not** deleting the zero-box branch — that branch is the
  one that would catch a badge the zoom really did crush.
- **The dragging-alternative check found no sliders**, because the Lab opens
  closed and then on a tab that has none. It clicks through to Pose first, and
  the check requires the count to be non-zero as well as clean.
- **The Tab walk reported 86 of the page's focusables unreachable**, and the
  page was fine: the Inspector's modal `<dialog>` was still open from the scan
  above it, and a focus trap working exactly as designed had been measured as a
  defect. The walk closes it and asserts that it closed.
- **The coarse-pointer leg measured the 36 px rule and called it 44.**
  `Emulation.setEmulatedMedia` accepts `prefers-reduced-motion` and silently
  rejects `pointer`, so `matchMedia('(pointer: coarse)')` was false and the
  `@media` block had never been asked to apply; the leg then dutifully reported
  five controls under 44 px. Touch emulation is the route that works, and the
  leg now asserts `coarse === true && fine === false` before it measures
  anything.
- **The inert guards did not exist for a whole run.** The edit script that was
  supposed to add them to three scans failed on its second replacement and
  exited *before writing the file*; the first replacement was reported as
  applied and was not. The run that followed reported nine unreachable rail
  buttons — a real-looking accessibility failure caused by a check that had
  silently never been changed. Every subsequent edit verifies its own
  occurrence count and prints which replacement landed.
- **The pointer-only scan reported 113 clickables on the Inspector screen** —
  eight rows and the 105 cells that inherit their `cursor: pointer`. The unit
  of the question is the datum, not the element, so the scan climbs to the
  outermost contiguous `cursor: pointer` ancestor and asks there. A row with
  nothing focusable inside it still fails, which is the state both the joint
  rows and the trace lanes were in before W6.

---

## 11. Verification

- `pnpm -r run test` — **1,031 passing**, unchanged. W6 added no unit tests: its
  claims are about rendered pixels, computed styles and hit tests, none of which
  jsdom can answer, and a jsdom test that asserted a contrast ratio would be
  asserting the stylesheet rather than the browser.
- `pnpm run typecheck` — clean.
- `node scripts/capture-web-screenshots.mjs` — **41 captures, 0 problems**, full
  run with QEMU. Three new: `w6-zoom-200.png`, `w6-text-spacing.png` and
  `w6-grayscale-provenance.png`. The two
  NOTEs it prints are W4's and W1's, unchanged.
- Every pre-existing assertion still holds: ISSUE-20260823-023 at every
  breakpoint and across every module switch, W1's type floor and token
  discipline, W2's 0 viewport-dependent pane differences, W3's derived mode and
  environment line, W4's three representations, W5's scroller rule, the Face
  zoom ladder and `declareOledFramebuffer()`, W7's single `activeModule`, W8's
  graph zoom across a node click and the QEMU default.
- **Zero new dependencies.** The contrast maths, the WCAG relative-luminance
  formula and the alpha compositing are 40 lines in the harness. The lockfile is
  untouched.

---

## 12. Not done, and why

- **Camera orbit has no keyboard path.** §6, with what it would take.
- **The status strip is 36 px, not the 32 px §3 computed.** Stated here rather
  than smoothed: the four quick commands could not reach the project's 36 px
  target inside a 32 px row that is `overflow: hidden`, and a check reading
  rectangles would have passed a button painted eight pixels short. Both stage
  rules still hold at every window.
- **`--accent` and `--simulated` are still the same value** (`#6e9ee6`). They
  are already separate tokens, which is what the brief asks for — *"so a future
  palette revision can change generic action styling without changing
  provenance"* — and giving them different values today would be a repaint the
  plan rules out.
- **No forced-colors (`@media (forced-colors: active)`) support.** Colour is
  removed entirely and photographed — `filter: grayscale(1)` on the root, §7 —
  which is what settles whether the hues were load-bearing. A Windows
  high-contrast theme does more than that: it replaces the palette with the
  system’s own and overrides backgrounds and borders, and neither that
  rendering nor a `forced-colors` block has been written.
- **The side panel is still 8 px over its box at 1280×800 once a `wave` has
  grown the trust card** — down from 14 px, but not zero. §9.2 has both
  measurements. Closing it means changing which of W5's four cards may shrink,
  which is a panel redesign rather than an invariant.
- **The subsystem graph dips under its zoom floor for about half a second
  after a resize, and it is not W6's.** §13.
- **The full 63-node graph's fitted label size** remains W4's and W7's open
  item, untouched here.

---

## 13. The zoom race, checked rather than labelled

One full harness run came back with a single problem: **23 runs of text at
14.4 px authored and 13.38 px on screen** in the modules pane at 1920×1080 —
the subsystem view drawn at **zoom 0.929**, which is exactly the number W7
recorded when it added its zoom floor. W6 had just touched
`ArchitectureGraph.tsx`, so "known issue" was not a label available without
evidence.

**The evidence.** The trigger is a resize: React Flow answers one with a refit,
and a refit computed against a container width it measured a frame too early
lands under the floor. Driving the eleven container widths the sweep uses and
then restoring them reproduces it on demand — and it reproduces on a build with
none of W6 in it:

| build | reading after the restore |
|---|---|
| this workstream's | subsystem, 750 px surface, **zoom 0.9946** |
| `8ce8c35` — W5, none of W6 applied | subsystem, 750 px surface, **zoom 0.9969** |

Same point in the sequence, one round in five each. The W5 baseline was built
from `git checkout 8ce8c35 -- apps/web/src` and measured with the identical
probe, and the tree was restored byte-for-byte afterwards. **It is
pre-existing.** The only line W6 changed in that path is `duration: 200`
becoming `motionDurationMs(200)`, which returns 200 whenever reduced motion is
off — as it is in every leg of a normal run.

**What W6 did, and what it did not.** It did not fix the race. A continuous
zoom-floor subscription was written, could not be shown safe — an effect that
re-fires on every viewport frame is not something to leave in unverified — and
was removed. What went in instead is `settleGraph()`: a bounded wait for the
viewport transform to stop moving, before the type scan reads what is **on
screen**. Bounded at 3 s and then measuring anyway, with a `check` on whether it
settled, so a graph that is *persistently* below its floor still fails. That is
the property separating settling from suppressing.

**Outcome.** The failure has not recurred in the runs since. That is not proof
it is gone — it is a race, and the honest statement is that its window is now
narrow enough that the harness stopped landing in it. The transient itself
belongs to W7/W8's open zoom item: a reader at 1920×1080 who resizes the
architecture pane can get a fraction of a second of 13–14 px labels in the
representation whose whole claim is that authored size is on-screen size.
Recording that is the end of it; absorbing it into a green run without saying
so would not have been.
