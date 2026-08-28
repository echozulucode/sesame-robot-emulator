---
task: "U1–U5 — responsive shell: left rail · maximised stage · collapsible right dock"
phase: 3
status: superseded in part by U6
date: 2026-08-26
owns: apps/web, scripts/capture-web-screenshots.mjs
superseded-by: docs/findings/U6-two-dock-shell.md
---

# U1–U5 — the responsive shell

> **Read `U6-two-dock-shell.md` after this one.** Three parts of what follows
> are no longer what is on screen: the *stage strip* that held the commands and
> the OLED is gone (both are sections of a second, inboard **control dock**, and
> a 34 px status line took its place); below Wide there is **one open section
> across both docks** rather than one per dock, behind **one scrollbar**; and the
> `[data-command="wave"]` reachability assertion was replaced by a stronger,
> hit-tested one. Everything else here — the overlay-not-push rule, the stage
> floor, the mounted-not-unmounted sections, the §5 badges and the
> `origin === 'scene'` restriction — is still in force and still asserted.

**Trigger:** a user evaluating the product on a laptop — *"For medium screens like
my laptop, you can barely see the robot at all."*

`apps/web/src/styles.css` was 2,407 lines with **zero `@media` queries**, and
`.app` was a fixed grid:

```css
grid-template-columns: minmax(0, 1fr) minmax(0, 520px) 400px;
grid-template-rows:    minmax(0, 1fr) minmax(0, 380px) auto auto;
```

Both fixed columns and the fixed source-explorer row were unconditional. The
robot got whatever was left.

That survived twelve tasks of harness work because **all 26 captures ran at one
window and none of them asserted how much space the viewport got.** Closing that
gap is U5, and it is the part of this change that stops the next one shipping the
same way.

---

## 1. Measured, before and after

Read off the live page: the **canvas element's own rect**, not the container's
CSS, because a container can be tall while the drawing buffer is not.

| Window | Old canvas | Old share of window height | **New canvas** | **New share** |
|---|---|---|---|---|
| 880 × 900 (Compact) | 300 × 150 | **19.4 %** | 754 × 662 | **82.0 %** |
| 1280 × 800 (Medium) | 334 × 91 | **12.9 %** | 1154 × 566 | **80.0 %** |
| **1440 × 900 (Medium — the laptop)** | **494 × 191** | **23.7 %** | **1314 × 646** | **80.0 %** |
| 2560 × 1440 (Wide) | 1614 × 731 | 54.3 % | 2018 × 1171 | **86.9 %** |

The 1280 × 800 row is the sharpest: **334 × 91**. That is below the 480 px width
floor *and* below the 45 % height floor, and the old harness reported it green.

And the dock costs the stage nothing below Wide — measured with the dock shut,
then open:

| Window | Stage width, dock shut | Stage width, dock open | Moved |
|---|---|---|---|
| 880 × 900 | 754 px | 754 px | **0.0 px** |
| 1280 × 800 | 1154 px | 1154 px | **0.0 px** |
| 1440 × 900 | 1314 px | 1314 px | **0.0 px** |
| 2560 × 1440 | 2434 px | 2018 px | 416 px — *in flow at Wide, which is correct* |


---

## 2. What was built

Three zones, in `apps/web/src/ui/Shell.tsx` (layout) and `ui/shell-state.ts`
(the decisions, unit-tested).

```text
┌──┬────────────────────────────────────────┬─────────────────┐
│R │            CENTER STAGE                │  RIGHT DOCK     │
│A │        3D robot, ≥ 45vh / ≥ 480px      │  ▾ Inspector    │
│I ├────────────────────────────────────────┤  ▾ Modules      │
│L │  commands + OLED  (fixed-height strip) │  ▾ Signal       │
└──┴────────────────────────────────────────┴─────────────────┘
 56px          flexible, never < 45vh         0 / 44 / 320–520
```

**Left rail — 56 px, never collapses.** Learn/Lab mode buttons, the three
backend buttons, the connection dot and the **provenance chip**. It never
collapses because the provenance badge must never be more than a glance away,
and that is a product-honesty requirement rather than decoration. The chip is a
*summary* of the banner in the inspector, not a second opinion: both read
`store.drivingProvenance` and `store.drivingOrigin`, so they cannot disagree.

**Center stage.** The 3D viewport with a hard floor of `min-height: 45vh` and
`min-width: min(480px, 100%)`, plus a fixed-height horizontally-scrolling strip
underneath holding the command vocabulary and the OLED. The strip is fixed-height
and scrolled rather than wrapped on purpose: a strip that grew a second row at
900 px would take back exactly the height this change exists to give away, and it
would do it at the width that can least afford it.

**Right dock — six accordion sections.** `Inspector` (backend panel, emulator
facts, joint inspector, asset facts), `Modules`, `Signal`, `Source`, `Learn`,
`Lab`.

| Breakpoint | Width | Dock |
|---|---|---|
| Compact | < 900 px | hidden; opens as a full-height sheet over the stage |
| **Medium** | **900–1440 px** | 44 px icon strip; opens as an **overlay, not a push** |
| Wide | > 1440 px | docked at 320–520 px, drag-resizable, double-click to reset |

### The overlay rule, and how it is enforced

Below Wide the dock is `position: absolute` inside the shell, so it is **out of
flow**: the stage's box does not know it exists. The stage reserves exactly the
44 px icon strip with a `margin-right` — a margin rather than a flex column,
because a column is a thing that could later grow.

That is not a comment, it is an assertion: phase 12 measures
`[data-testid="stage"]`'s width with the dock shut, opens the dock, and measures
again. Below Wide the two must agree to within half a pixel, and the canvas
width must be unchanged too.

### Sections collapse; they never unmount

Collapsing sets `hidden` on the section body. That is load-bearing in four
places, and each of them is an assertion somewhere else in the harness:

- L4's refusal check asserts **zero `.src-line` nodes** when the bundled source
  fails its hash. An unmounted pane also has zero, so unmounting would make the
  sharpest check in the harness pass vacuously.
- L6's checks re-evaluate every 250 ms against live state, and
  `face-mode-identified` can only be answered from a sample taken *while* a
  movement runs. An unmounted runner stops sampling.
- L4 asserts exactly one `concept-text` element exists — two responsive copies of
  a pane would be two.
- V8's `visual.joint` rung is read off `Object3D.quaternion`: what was actually
  drawn. The stage is never unmounted either.

L7's *opposite* requirement is preserved by not touching it: `LabMode`'s own
closed strip, where it does not subscribe to `LessonRuntime` at all, is its own
state and is unaffected by whether its dock section is expanded.

### Persistence

`sesame-lab.shell.v1`, per breakpoint, on exactly the terms
`lessons/progress.ts` and `lab/lab-doc.ts` set: every read and write wrapped,
correct render with nothing stored, unrecognised records discarded rather than
merged. 22 new unit tests cover the three ways storage fails, the breakpoint
edges (1440 is Medium, 1441 is Wide), the clamp, and the refusal to let a
two-section record from Wide smuggle a second open section into Medium.

---

## 3. §5 — the cross-highlight, which was the real risk

Clicking `R4` in the 3D scene highlights it in the graph, the trace and the
inspector. If those sections are collapsed **the highlight happens where nobody
can see it and the app appears to do nothing** — a regression in the feature
Phase 2 spent the most effort on. Both mitigations the plan requires are built:

1. **A collapsed header carries the selection.** `Inspector ● R4`,
   `Modules ● joint.R4`, `Signal ● 4 rows`, `Source ● runWavePose`. Collapsed
   headers also carry live state when nothing is selected — event count, lesson
   progress, and whether Sesame Lab is currently modifying this robot.
2. **`selectJoint`/`selectNode`/`selectSymbol` auto-expand their target section**
   below Wide, and open the dock to do it.

**One deviation from the plan, and it is deliberate.** The auto-expand fires only
for selections whose `origin` is `'scene'` — the case §5 actually describes.
A click inside a pane that is already open needs no help, and `LessonRunner`
calls `selectSymbol` with origin `'source'` on several steps: hijacking the
accordion there would collapse the lesson a learner is mid-way through, breaking
Learn at Medium in order to fix a problem Learn does not have. Phase 12 asserts
both halves — the auto-expand from the scene, and that a selection made from
inside a lesson leaves the lesson open.

---

## 4. What this cost, stated rather than hidden

**The source explorer lost its three columns.** It was `190px | 1fr | 330px` —
the outline, the code and the context side by side, about 700 px of width. The
dock is 320–520. So the three columns are three **stacked, individually
scrolling regions** with bounded heights: outline 130 px, code `1fr` with a
200 px minimum, context up to 220 px, in a section with a 480 px floor.

The bounds are the load-bearing part. L4 asserts that selecting a joint
*scrolls* the code view to the symbol's first line, measured against
`.source-code`'s own `clientHeight`. An auto-sized row would let the code region
grow to all 429 lines of `movement-sequences.h`, and the pane would never scroll
— the assertion would keep passing and stop meaning anything.

**The `Controls` panel was split in two.** `BackendPanel` (switch, connection
detail, provenance banner with `#prov-banner`, `#origin-banner`,
`#measurement-verdict`) went into the dock's inspector section; `CommandBar`
(the command and face vocabulary) went onto the stage, where it is reachable at
every breakpoint without opening anything. Every id, class and `data-*`
attribute is the one it was.

**Learn is a sixth dock section.** The plan's §2 table lists five and puts a
Learn/Lab *mode switch* on the rail. Making Learn and Lab exclusive modes would
have destroyed state on every switch, so both are accordion sections and the
rail's mode buttons reveal them. Nothing is unreachable and nothing is
exclusive.

**The row-not-column argument is superseded, not ignored.** L4 §5, L6 §7 and
L7 §7 each argue that a new pane must take a grid *row*, because a column comes
out of the viewport's width and that is the class of change ISSUE-20260823-023
came from. The dock is a column. The answer is not an argument — it is that
below Wide the column is out of flow and takes nothing, at Wide the stage is
2,000 px or more, and the world-frame check is now re-run **at every breakpoint
and across a dock resize**, which is the only path left that still resizes the
renderer's canvas.

---

## 5. Verification

`docs/findings/assets/v3-v4-browser-capture.json` → `phases.responsiveShell`.
Phase 12 opens **four real browser windows** — not a CDP metrics override, which
would be measuring the emulator rather than the layout — and at each one:

| Check | Result |
|---|---|
| Canvas ≥ 45 % of window height, dock shut **and** open | 82.0 / 80.0 / 80.0 / 86.9 % |
| Canvas ≥ 480 px wide | 754 / 1154 / 1314 / 2018 px |
| Robot drawn — non-background share of the middle of the drawing buffer | 54.0 / 43.0 / 52.3 / 93.5 % |
| **Dock overlays, does not push** — stage width shut vs open | **0.0 px** at Compact and both Mediums |
| Collapsed section carries the selection — `Inspector ● R4`, in the rendered header text | pass at all four |
| `selectJoint` from the 3D scene auto-expands `Modules` and opens the dock | pass below Wide |
| Section collapse + dock width survive a real `location.reload()` | pass at all four |
| **ISSUE-20260823-023** — ground plane, GLB root, orbit target, camera | **0.000000 mm** while the foot contact swept 37.5 mm, at every breakpoint |
| **ISSUE-20260823-023 across a dock resize** (320 → 520 px at Wide) | **0.000000 mm** |
| Dock at its 520 px maximum still clears both floors | pass |
| Learn plays lesson 2 end to end at Medium — six checks, one driven to `failed` first | pass |
| A selection made from inside a lesson does not collapse the lesson | pass |
| Lab's C++ export re-parsed at Compact against the poses the sliders authored | 2 frames, 16 writes, byte-exact |

**All 934 workspace tests pass (22 new). 32 real-browser captures, 0 problems,
full run with QEMU** — a clicked button drove real firmware under Espressif QEMU
through the new shell and every joint it moved still carries
`origin.kind="emulator"` with `isPhysicallyObserved()` false.


### New captures

| File | What it shows |
|---|---|
| `u5-shell-compact.png` | 880 × 900 — the dock as a full-height sheet over a stage that kept its width |
| `u5-shell-laptop-small.png` | 1280 × 800 — the window that was 334 × 91 before |
| `u5-shell-laptop.png` | **1440 × 900 — the machine the complaint came from** |
| `u5-shell-desktop.png` | 2560 × 1440 — the dock in flow, graph and trace open together |
| `u5-learn-at-medium.png` | lesson 2 finished on a laptop, the stage untouched |
| `u5-lab-at-compact.png` | the Lab sheet at 880 px, its C++ export re-parsed here |

### What changed in the existing captures

- **The default harness window moved from 1440×860 to 1600×1000.** 1440×860 is
  *Medium* under the new shell — one open section at a time and an icon-strip
  dock — and phases 7, 8, 10 and 11 each need a specific pane laid out and
  measurable, while phase 7 needs the architecture graph and the Signal trace on
  screen **at once**, which below Wide is physically impossible. This changes the
  framing of all 26 captures. It changes what none of them assert.
- **Four `scrollTo` targets** moved from `.sidebar` / `.workbench` — the old
  third column and middle column — to `[data-testid="dock-body"]`.
- **`openSection()` calls were added** to phases 8, 9, 10 and 11. The panes stay
  mounted when a section collapses, so most assertions would have passed
  regardless; the ones that would not are the geometric ones (L4's scroll
  position, L7's pointer drag across the pixel canvas), and a refusal asserted
  against a pane nobody could see would be exactly the vacuous check phase 9
  exists to avoid.
- **`focusSection()` calls were added before fifteen captures.** The panes were
  grid rows before and all on screen at once; a screenshot taken without this
  shows the dock's first section rather than the pane the phase just proved
  something about. No assertion is involved — it keeps the evidence legible.
- **Phase 7 gained two assertions** rather than losing any: that the session is
  at Wide, and that `modules` and `signal` are open together. V8's argument for
  splitting the workbench was that the cross-highlight is the feature and a
  scroll between the two destroys it; that is now checked instead of assumed.
- **Phase 10's ladder step gained a stronger wait.** It waited for
  `checkStatus === 'passed'`, but lesson 1's `run-stand` leaves a complete trace
  on screen, so the check is *already* passed when the step opens: the wait
  returned on the previous trace and the read that followed landed inside the
  new one — "7 of 8", with `visual.joint` still a `useFrame` sample away. It now
  waits for the observed string that only the passed branch produces, on the
  trace this click opened. That is strictly stronger than what it replaced, and
  it is a pre-existing race the new timing exposed rather than caused.
- **No assertion was dropped.**

---

## 6. Files

| File | What |
|---|---|
| `apps/web/src/ui/shell-state.ts` | breakpoints, section set, persistence, `sectionForSelection` |
| `apps/web/src/ui/Shell.tsx` | `useShell`, the rail, the dock, the accordion, the drag handle |
| `apps/web/src/ui/Controls.tsx` | split into `BackendPanel` and `CommandBar` |
| `apps/web/src/App.tsx` | the three-zone tree, section specs, collapsed-header badges |
| `apps/web/src/styles.css` | the shell, three breakpoints, the source pane's stacked rows |
| `apps/web/src/debug-hook.ts` | `shell()`, `setSection()`, `setDockOpen()`, `setDockWidth()` |
| `apps/web/src/__tests__/shell.test.ts` | 22 tests |
| `scripts/capture-web-screenshots.mjs` | phase 12, plus the capture updates above |

**Zero dependencies added; the lockfile is untouched.** No colour, type scale or
register changed — L4's computed-style assertions on `description`,
`commentary` and `libraryEvidence` still pass unmodified. No provenance surface,
`isPhysicallyObserved()` branch, `conceptual` badge, NOT BUILT panel or
modifying-this-robot banner was touched.
