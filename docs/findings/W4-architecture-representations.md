---
task: "W4 — the architecture graph's three representations"
phase: 4
status: complete
date: 2026-08-28
owns: apps/web, scripts/capture-web-screenshots.mjs
plan: docs/plans/phase-4-ui-ux-revision.md §4 W4
source: "docs/research/Sesame Lab_ responsive UI_UX research brief.md"
follows: docs/findings/W3-one-workbench.md
amends: docs/findings/V8-architecture-graph-and-signal-trace.md
---

# W4 — three representations, and the complaint that started Phase 4

**Trigger:** the user's own words, still open after three layout iterations.

> *"the architecture pane is so tiny that it is unusable on medium screens."*

W1 measured it getting **worse**. Node labels went 9.0 → 8.0 px at 1440 and
4.2 → 3.8 px at 880, because a bigger node box makes `fitView` pick a smaller
zoom. It was already three to six times below the 14 px floor, and W1 said so
plainly rather than absorbing it: `data-zoom-surface` exists so the type
invariant could not pretend the problem was solved.

**No type size fixes this. The artifact had to change.**

---

## 1. What is on screen now

| Surface width | Representation | What it is |
|---:|---|---|
| **< 720 px** | **causal path** | one chain from `ESP32` to the part in question, its derived edge labels, its nearby branches, and the provenance-tagged events it produced |
| **720–959** | **subsystem graph** | one neighbourhood, ≤ 18 nodes, React Flow with a **zoom floor of 1** |
| **≥ 960** | **full graph** | all 63 nodes, React Flow exactly as V8 built it |
| explicit action | **focus workspace** | the pane takes the content area, Sesame stays live and smaller |

The width branched on is the **artifact's own box** (`.arch-surface`), about
46–56 px narrower than the pane's content box. W2 established that asymmetry and
it is kept for the same reason: the invariant is *"the 63-node graph is not
mounted below 720 px of container"*, and measuring the smaller box can only
scope the representation harder than the rule requires, never softer.

### The measurement this task exists for

Smallest run of text **on screen** inside the architecture panel — computed
font size times the transform actually in force — against W1's numbers for the
same panes:

| Window | pane | surface | representation | **W1, React Flow** | **W4** |
|---|---:|---:|---|---:|---:|
| 880 × 900 Compact sheet | 613 | 563 | causal path | **3.8 px** | **14.00 px** |
| 1280 × 800 workbench | 459 | 413 | causal path | — | **14.00 px** |
| **1440 × 900 workbench** | **489** | **443** | **causal path** | **8.0 px** | **14.00 px** |
| 1600 × 1000 workbench | 519 | 473 | causal path | 3.7 px | **14.12 px** |
| 1760 × 1000 analysis dock | 397 | 351 | causal path | — | **14.26 px** |
| 2560 × 1440 analysis dock | 397 | 351 | causal path | **5.1 px** | **14.98 px** |
| 1280 × 800 + workspace | 909 | 859 | subsystem, zoom 1.00 | — | **14.00 px** |
| 1600 × 1000 + workspace | 1186 | 1136 | full, zoom 1.04 | — | **14.12 px** |
| 1760 × 1000 + workspace | 1251 | 1201 | full, zoom 1.11 | — | **14.26 px** |
| 2560 × 1440 + workspace | 2023 | 1973 | full, zoom 1.82 | — | **14.98 px** |
| 1440 × 900 + workspace | 1054 | 1004 | full, **zoom 0.92** | — | **12.92 px** |

The last row is the honest one and it is §6.

**No representation in the ordinary layout is a zoom surface any more.** The
path view has no transform anywhere in its subtree and the subsystem view has a
zoom floor of 1, so in both of those the authored size *is* the on-screen size
and the ordinary 14 px floor is asserted against what is drawn, with no
exemption. `data-zoom-surface` is now the full graph's alone, and the harness
fails if any other representation claims it.

## 2. Reconciling W2's bands with the brief's

W2 built `ui/use-container-width.ts` with `PANE_BANDS` at **520 / 720**, mirrored
one-for-one by the two `@container` thresholds in `styles.css`, and its harness
**fails statically on a third threshold** — *"that is how a responsive system
becomes forty unrelated numbers"*. The brief's architecture thresholds are
**720 / 960**.

**Resolved as two tables, deliberately, with the relationship written down.**

| | `PANE_BANDS` | `ARCH_BANDS` |
|---|---|---|
| question | does this pane have room for two columns? | does this pane have room for *this diagram*? |
| derived from | column count | 63 nodes / 65 edges, and a 10–18 node neighbourhood |
| read by | CSS (`@container`), and W2's `data-pane-band` | React (`archModeForWidth`), and W4's `data-arch-mode` |
| thresholds | 520 / 720 | 720 / 960 |
| shared by | Inspector, Signal, Learn, Modules chrome | the architecture artifact only |

Extending `PANE_BANDS` to 520/720/960 was the alternative and it is worse twice
over: it adds the third generic threshold W2's static check forbids, and 960 has
no meaning at all for the Inspector's seven columns or the Signal row. Merging
the other way — moving the panes to 720/960 — would change the Inspector and
Learn for a reason that has nothing to do with them.

They coincide at 720 and that is allowed: *"this pane can hold two columns"* and
*"this pane can hold one subsystem"* are different statements that happen to
have the same answer. `data-pane-band` is still published and still asserted
against `paneWidthBand()`; W2's assertion is untouched.

**One W2 assertion did have to move.** The band was published on `.arch-canvas`,
and below 720 px there is no canvas — the artifact is flow text. Reading it off
a box that exists in two of the three representations would have made every
architecture assertion in the container sweep **skip silently in the third**,
which is exactly the hollow-assertion failure this project has hit three times.
It is published on `.arch-surface`, which always exists, and the sweep reads it
there.

## 3. React chooses; CSS does not hide

The brief is explicit and the harness proves it rather than trusting it. In the
causal-path representation the sweep asserts, at every container width below
720 px in two different windows:

- `0` React Flow canvases in the DOM,
- `0` `.react-flow__node` elements,
- `0` `.react-flow__background` elements,
- `0` `[data-zoom-surface]`.

Not `display: none` — **not in the tree**. A stylesheet cannot decline to mount
something, so a canvas found there would mean the switch had been faked.

## 4. Cross-highlighting, in all three

V8's `SelectionState` is untouched. Every node in every representation is
`[data-arch-node]` and calls the same `selectNode()`, so there is one object and
one code path rather than three. Asserted in the browser, through the **scene
graph**, because a React `selected` prop can be correct while the mesh stays
unlit:

| Direction | path | subsystem | full |
|---|---|---|---|
| 3D → graph (`selectJoint("L3")`) | `joint.L3` is on the chain and marked `data-selected` | node selected, and the viewport **pans to it** | node selected |
| graph → 3D (DOM click) | `joint.L4` from the branch row → `litJoints: ["L4"]`, `emissiveIntensity > 0` | `joint.R4` → `litJoints: ["R4"]` | `joint.R4` → `litJoints: ["R4"]` |
| a node about *all eight* joints | `servo.ledc` → `joint: null`, and `litJointsFor()`'s symbol arm lights all eight | same | same |
| graph → trace | the chain's own events are listed in the pane, with provenance and origin | via the Signal pane | via the Signal pane |

The middle row of that table is a correction I owe the harness: the first
version of the check asserted that selecting LEDC lit **nothing**, and the app
was right and the assertion was wrong — `litJointsFor()` falls back to the
joints the *symbol* commands, which for LEDC's citation is all eight. That is
V8's documented behaviour and it is identical in all three representations.

**Reachability.** A scoped view that could not reach a node would be a subset of
the product rather than a view of it. Each path step lists three branches and
then a `+N more` control that opens the rest in place, so `joint.L4` is
selectable from a chain that ends at `joint.R1`. The harness clicks that
control and then that node.

**One behaviour is new and worth keeping.** In the subsystem view the viewport
re-frames on the focus node **and its predecessor on the causal path** — for
`R1` that brings `MG90S` into view, which is *"which servo drives this joint"*,
and it is the hand-authored edge, so the frame that teaches is also the frame
that shows where the evidence stops.

## 5. L6's graph-node clicks

Three lesson steps use the `graph-node-picker` control:

| lesson | status | target | resolves | reachable |
|---|---|---|---|---|
| `meet-sesame` | **polished** | `oled` | yes | `esp32 → face → oled`, and in the Face subsystem |
| `sesame-on-a-network` | outline | `network` | yes | `esp32 → network` |
| `two-wires-to-a-face` | outline | **`i2c`** | **no** | — |

The control is a **button in the Learn pane** that calls `selectNode(target)`,
not a click inside the graph, so no representation can stop a step from firing.
The only polished one is `meet-sesame`, which phase 10 and phase 12 play end to
end and which is unaffected.

**`i2c` is not a node id. The generated node is `oled.i2c`.** This predates W4 —
`selectNode('i2c')` has always set a `nodeId` no pane can render — and the
lesson carrying it is `outline`, so L6 never built it and nothing plays it. It
is **reported rather than smoothed over**: `causalPath()` degrades to the root
for an unknown id instead of guessing, and a unit test records the mismatch
verbatim so that fixing `hardware/lessons.json` fails the test and says so.
`hardware/` is not this task's to edit.

## 6. What is NOT fixed, said plainly

**The full 63-node graph still draws below 14 px when it is fitted.** The
harness records the worst it finds, every run, as a NOTE:

> the FULL 63-node graph still draws text below the 14px floor when it is
> fitted: **6.01px** at its worst, modules at a 1198 px container in a
> 2560×1440 window.

(The sweep's containers are short — a driven pane keeps the dock's height — so
that is the worst case rather than the typical one.)

In the focus workspace, **collapsed**, where a reader would actually meet it, it
is much better — zoom 0.92 to 1.82, so 12.9 px at 1440 and 14–15 px from 1600
up. **Expanded it is not.** `Servos` opens a 13-node chain eight rows deep;
`Reframe` fits that subtree rather than the whole map, and the subtree is still
about 1,200 model pixels tall in a 620 px canvas, so the zoom lands near 0.43
and the labels near 6.5 px. `docs/findings/assets/v8-architecture-servos-expanded.png`
shows exactly that, and it is left in the findings rather than reframed into
something flattering.

What a reader does there is **pan** — the surface is a declared
`[data-2d-surface]`, and WCAG's reflow criterion recognises that diagrams
sometimes need two-dimensional layout rather than text reflow. What the brief
adds, and what W4 acts on, is that *"accessibility permission to pan does not
make a 63-node graph understandable in a narrow column"*. So panning is the
answer for the reader who deliberately opened the whole map in a workspace, and
it is **not** the answer for the pane a laptop gets by default — which is the
whole point of the split.

**It is not fixed. It is scoped.** The full graph is now the only
representation that does not render below 960 px of surface, it is the only one
still carrying `data-zoom-surface`, and the two representations a laptop
actually gets are asserted against the floor with no exemption at all. The only
way to fix it *inside* React Flow is to refuse to fit — which is panning a
63-node map inside a pane, the exact thing the three representations exist to
avoid.

## 7. The focus workspace, and the exemption

**"Open architecture workspace"**, a button in the pane it is for. The stage
becomes `clamp(240px, 18vw, 340px)` and the pane takes the rest.

It is **not a fourth mode.** It changes the pane's *width*; `archModeForWidth()`
then chooses, which is why the workspace on a 1280 px laptop honestly gives the
**subsystem** graph and says so, instead of claiming a map that would not fit.

### The stage-area rule is scoped, and the exemption is visible

W3 replaced `overlay-not-push` with *"the stage keeps ≥ 50 % of the window's
area"*. The brief is explicit that this one arrangement is the exception:

> *"This is the one place where I would interpret 'robot must remain dominant'
> as product identity and persistent causal feedback, not literally 'the robot
> must own more pixels than every task surface at every instant.' Enforcing
> literal pixel dominance while reading 429 lines of C++ or navigating 63 nodes
> would make those tools unusable."*

**The app declares which rule is in force.** `.shell` carries
`data-stage-rule="area-50" | "focus-exempt"` beside `data-focus-pane`. That is
the whole point: a harness that decided the exemption for itself would branch on
the same condition the layout branches on and could never disagree with it —
the fourth hollow assertion. What is asserted instead:

| | assertion | measured |
|---|---|---|
| the ordinary layout **never claims** the exemption | `stageRule === 'area-50'` at every window, every workbench state, in phase 12 | 5 windows × 3 states |
| the exemption is **needed** | with the workspace open, the stage is **below** 50 % | 17.3 % at 1440/1600/1760, 13.1 % at 2560, 18.2 % at 1280 |
| the robot is still **there** | canvas ≥ 220 px on each side — the floor that *replaces* the 480 px width floor | 255 × 741 at 1440, 240 × 641 at 1280 |
| the robot is still **live** | ≥ 2 % of the middle of the WebGL drawing buffer is non-background, read with `readPixels` | passes |
| the exemption **ends** | closing it returns the stage area to its pre-workspace value and `stageRule` to `area-50` | ±0.5 % |

The workspace also closes itself when its pane leaves the screen, so
"exempt while a mode is on" cannot quietly become "exempt".

## 8. What the screenshots said that the numbers did not

Four things were wrong on screen and green in arithmetic. All four were found by
looking.

1. **`@layer` beat specificity, twice.** The workspace's canvas-height rule was
   written beside the rest of the workspace geometry in `@layer shell` and did
   nothing at all: `.arch-canvas`'s `flex: 1 1 auto` lives in `components` and
   the 52vh rule in `panes`, and both outrank `shell` regardless of selector
   weight. It is in `panes` now, with the reason recorded next to it.
2. **Width without height does not fix a fitted graph.** At 1760 × 1000 the
   workspace took the pane from 351 px to 1,201 px and the labels stayed at
   **5.7 px**, because `fitView` fits the short side and the analysis dock gives
   three open sections a third of the column each. `flex: 4` did not help
   either — three `min-height: 220px` sections already exceed the column, so
   there is no free space for a ratio to divide. A `min-height: 74vh` on the
   focused section is what actually reserves it.
3. **A percentage against an out-of-flow parent.** At Compact the workspace made
   the sheet *narrower* — 563 px → 307 px — because `.docks` is absolutely
   positioned and shrink-to-fit there, so `width: min(92vw, 100%)` resolved
   against a box whose width depended on this one. `92vw` fixes it: 709 px.
4. **`.arch-panel { overflow: hidden }`** is right around a fixed-box React Flow
   and wrong the moment the box is taller than the panel's share: the first
   workspace screenshot had the hint paragraph half-drawn under the canvas.

And one screenshot was **deleted rather than kept**: phase 7 drives the modules
pane to 900 px to prove the subsystem switch, which spills 440 px off the right
of the window. Fine as a measurement, misleading as a picture. The subsystem
representation is photographed in phase 12 instead, at 1280 × 800 with the
workspace open, which is a layout a reader can actually reach.

## 9. Verification

**Unit — 26 new tests** (`src/__tests__/representation.test.ts`), 269 in
`apps/web` and **985 across the workspace**, up from 959:

- `archModeForWidth` is the brief's function verbatim, at 719/720 and 959/960,
  and treats an unmeasured box as the narrowest rather than the widest;
- the two band tables are separate, and the one number they share is asserted to
  be a coincidence rather than a shared rule;
- the causal path walks the brief's worked example for a joint, carries the
  generator's own edge labels rather than new prose, marks the hand-authored
  last edge, and **reaches every one of the 63 nodes**;
- the subsystem budget is never exceeded for any subsystem × any focus (4 × 63
  combinations), whole sibling sets or none, and is independent of the
  expand/collapse state;
- L6's three targets, including the one that does not resolve.

**In the browser** — `node scripts/capture-web-screenshots.mjs`:

| Where | What |
|---|---|
| phase 7, ordinary layout | the pane mounts `path`; 0 React Flow canvases, 0 flow nodes, 0 zoom surfaces; the eight chain nodes are drawn; the worst on-screen text clears 14 px, with a vacuity guard on the number of text runs |
| phase 7, workspace | the DOM button is **hit-tested**, ≥ 36 px; the surface reaches ≥ 960 px; the mode becomes `full`; the exemption's five checks in §7 |
| phase 7, after closing | `stageRule` back to `area-50`, area back to its pre-workspace value, mode back to `path` |
| phase 7, driven container | a 900 px modules pane mounts `subsystem`, names its subsystem, draws ≤ 19 nodes, and is drawn at **zoom ≥ 1** |
| phase 7, cross-highlight | all of §4, including the branch-row reachability path |
| phase 12, container sweep | **4 panes × 11 container widths × 2 windows**; the mode, the mounted canvas, the dot grid, the zoom-surface count and the 14 px on-screen floor at every width; **0 viewport-dependent differences** |
| phase 12, every window | the ordinary layout reports `stageRule === 'area-50'`, so the exemption cannot become permanent |
| phase 12, 1280 × 800 | the subsystem representation reached by the workspace, photographed |

Two container widths were added to the sweep — **776 and 1016** — because the
surface is ~56 px narrower than the pane, so a pane driven to 720 or 960 lands
the artifact on the wrong side of its own boundary. Asserting a boundary means
standing on it.

- `pnpm -r run test` — **985 passing**, up from 959.
- `pnpm run typecheck` / `pnpm run lint` — clean.
- `node scripts/capture-web-screenshots.mjs` — **35 captures, 0 problems**, full
  run with QEMU. Was 33; the two new ones are the causal path and the subsystem.
- **Zero new dependencies.**

Every pre-existing assertion still holds, including all of V8's: the collapsed
graph is exactly the report's nine nodes and eight edges, the five hand-authored
claims are enumerated, `servo.mg90s` is unresolved, `[data-expand="servos"]`
reveals the five-node chain and all eight joints in the layout *and* in the DOM,
`pwm.output` prints ticks and µs and **no channel number**, no row claims
physical observation, and ISSUE-20260823-023's world frame holds at 0.000000 mm
while the foot contact sweeps 37.535 mm.

**Where V8's assertions moved, and why.** The DOM-dependent half of them — the
expand click, the `[data-arch-node]` presence check, the `joint.R4` click — now
runs **inside the focus workspace**, because that is where the 63-node graph
lives. They are the same assertions against the same artifact; what changed is
that the artifact is no longer crushed into a 397 px dock. The model-level half
(node ids, edges, upstream commit, hand-authored list) never touched the DOM and
did not move.

## 10. Two things found on the way that are not W4's

**1. The two-dock Wide regime does not satisfy the 50 %-area rule at 1760 px.**
Recorded as a NOTE, every run:

> at 1760×1000 — the harness's own default window, and the bottom of the
> two-dock Wide regime — the stage holds **45.0 %** of the window's AREA with
> both docks open at their **default** widths, below W3's 50 % floor.

The focus workspace is not involved and this is not a W4 regression. W3 set the
Wide boundary at 1700 px from **360 + 360** px of dock; the shipped defaults are
**400 + 460**. Phase 12 does not catch it because the only Wide window it
measures is 2560 × 1440, where the same layout holds 75.7 %. The fix is W3's
arithmetic — a higher Wide boundary, or narrower defaults — not a change to the
architecture pane, and it is left to whoever owns that decision rather than
being adjusted quietly here.

**2. The Modules pane's collapsed-header badge says `N expanded`.** In the
causal-path representation nothing is expanded and the number is always `0`,
which is true and useless. The badge is computed in `App.tsx` from the
expand set and does not know which representation is mounted. It is pane chrome
and it is **W5's**, alongside the duplicated pane title W3 handed over.

## 11. Handed on

**W5.** The Modules badge above. Also: at the 351 px the *analysis dock* gives
the pane at Wide, the causal path is legible but cramped — it is the two-dock
regime that is narrow there, not the representation, and §10.1 is the same
finding from the other side.

**W6.** `data-arch-mode`, `data-stage-rule` and `data-focus-pane` are published
as data, so the representation invariants and the stage-rule invariant are
assertable against structure rather than text. The brief's two Modules
invariants — *"at Modules container width < 720 px, the complete 63-node React
Flow is not mounted"* and *"at 720–959 px, the full architecture is not the
default view"* — are both asserted now, at eleven container widths in two
windows. The 200 % zoom and text-spacing gates are still open and still W6's;
note that the causal path is ordinary flow text, which is the representation
most likely to survive both of them and the one a reader at 200 % zoom will get.
